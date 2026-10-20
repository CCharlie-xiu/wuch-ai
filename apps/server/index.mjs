// ─────────────────────────────────────────────────────────────────────────────
// 本地服务：静态文件 + 上游转发 + 会话接口（/api/*，存本地 SQLite，见 src/db.mjs）。
// 零依赖，bun run dev 即可。
//
// 为什么需要它：浏览器的 fetch 受同源策略约束，而 OpenAI / DeepSeek 这类
// 官方 API 不返回 Access-Control-Allow-Origin，所以从页面直连一定被 CORS 拦掉。
// 这个转发层只做一件事：把请求原样送给上游，把响应（含 SSE 流）原样吐回来，
// 并补上 CORS 头。
//
//   bun run dev                  # http://127.0.0.1:8788
//
// 设置里的接口地址填成：
//   http://127.0.0.1:8788/proxy?url=https://api.openai.com/v1
//
// 静态服务走下面这张【显式路由表】：每条 URL 形状对应的文件位置都写在代码里，
// 不做隐式推算。表里标为「约定路径」的条目是兼容映射 —— 物理文件已经从
// js/ 搬到 packages/ 与 apps/web/public/，但 URL 保持不变，所以调用端
// （session.js 的 fetch 与 runnerFrame.src）一行都不用改。
//
// 顺带一提：这就是「服务端」该在的位置。把 packages/compiler 也接进来之后，
// 页面就再也拿不到编译器，CSP 可以收紧到 default-src 'none'（见 DESIGN.md §3）。
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { openDb, createConversationRepo } from './src/db.mjs';
import { createApi, API_PREFIX } from './src/api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WEB = path.join(REPO_ROOT, 'apps', 'web');
const PORT = Number(process.env.PORT || 8788);
// 监听地址：默认 0.0.0.0（整个局域网可访问）；只在本机跑就 HOST=127.0.0.1。
// 注意：服务端会把模型配置里的 apiKey 原样返回给页面（本地单人工具的设计），
// 所以别把这个端口暴露到公网。
const HOST = process.env.HOST || '0.0.0.0';
const PROXY_PREFIX = '/proxy';

// ── 路由表 · 精确命中：URL → 文件 ────────────────────────────────────────────
const EXACT = {
  '/': () => path.join(WEB, 'index.html'),
  '/index.html': () => path.join(WEB, 'index.html'),
  '/demos.html': () => path.join(WEB, 'demos.html'),
  // 登录路由：和 /、/demos.html 平级，是独立文档（不是主应用上的一层浮层）。
  // 两种写法都收：/login 是给地址栏看的，/login.html 方便静态托管直接命中。
  '/login': () => path.join(WEB, 'login.html'),
  '/login.html': () => path.join(WEB, 'login.html'),

  // 约定路径：apps/web/src/session.js 用 runnerFrame.src = 'runner.html' 加载沙箱宿主
  '/runner.html': () => path.join(WEB, 'public', 'runner.html'),

  // 约定路径：apps/web/src/session.js 用 fetch('js/worker-runtime.js') 取运行时源码。
  // 物理文件已移到 packages/runtime，这里做兼容映射；调用端无需改动。
  '/js/worker-runtime.js': () => fileURLToPath(import.meta.resolve('@openui-lab/runtime/worker-runtime.js')),

  // 图表库：catalog 的图表组件在浏览器里按需 import('echarts')，import map 指到这里
  '/vendor/echarts.js': () => createRequire(path.join(REPO_ROOT, 'packages', 'catalog', 'package.json')).resolve('echarts/dist/echarts.esm.min.mjs'),
  // Markdown：MarkDownRenderer 按需 import('marked')
  '/vendor/marked.js': () => path.join(path.dirname(createRequire(path.join(REPO_ROOT, 'packages', 'catalog', 'package.json')).resolve('marked')), 'marked.esm.js'),
};

// ── 路由表 · 前缀命中：URL 前缀 → 目录 ───────────────────────────────────────
const PREFIXES = [
  ['/src/', () => path.join(WEB, 'src')],
  ['/css/', () => path.join(WEB, 'css')],
  // 共享包源码：供浏览器 import map 解析 @openui-lab/*（见 apps/web/*.html）
  ['/packages/', () => path.join(REPO_ROOT, 'packages')],
  // 公式：Formula 组件按需 import('katex')，样式表和字体按相对路径从同一目录取
  ['/vendor/katex/', () => path.dirname(createRequire(path.join(REPO_ROOT, 'packages', 'catalog', 'package.json')).resolve('katex/dist/katex.mjs'))],
  // 代码高亮：核心与每种语言各一个 ESM 文件，代码框用到哪种语言才取哪种
  ['/vendor/hljs/', () => path.dirname(createRequire(path.join(REPO_ROOT, 'packages', 'catalog', 'package.json')).resolve('@highlightjs/cdn-assets/package.json'))],
  // 界面字体霞鹜文楷：本地托管（见 apps/web/css/fonts.css），不依赖外网。映射到包根目录，
  // 包里的 css 用 ./files/… 相对路径引用按字符切片的字体文件，用到哪片才下哪片
  ['/vendor/fonts/lxgw-wenkai/', () => path.dirname(createRequire(path.join(WEB, 'package.json')).resolve('lxgw-wenkai-screen-webfont/package.json'))],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Disposition',
  'Access-Control-Max-Age': '86400',
};

const db = await openDb();
const handleApi = createApi({ repo: createConversationRepo(db), db, headers: CORS });

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS, ...headers });
  res.end(body);
}

/** 路由表查询：返回文件绝对路径，未命中返回 null */
function resolveRequest(pathname) {
  const exact = EXACT[pathname];
  if (exact) return exact();

  for (const [prefix, dir] of PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;
    const base = dir();
    const rest = pathname.slice(prefix.length).replace(/^\/+/, '');
    if (!rest) return null;
    const file = path.normalize(path.join(base, rest));
    // 目录穿越防护：规范化之后必须仍在 base 之内
    if (!file.startsWith(base + path.sep)) return null;
    return file;
  }
  return null;
}

/** /proxy?url=https://api.openai.com/v1  →  上游 base，路径与查询原样接在后面 */
function resolveUpstream(req) {
  const u = new URL(req.url, 'http://localhost');
  const target = u.searchParams.get('url');
  if (!target) return null;
  const rest = u.searchParams.get('path') || '';
  const base = target.replace(/\/+$/, '');
  return base + (rest ? (rest.startsWith('/') ? rest : '/' + rest) : '');
}

async function handleProxy(req, res) {
  const upstream = resolveUpstream(req);
  if (!upstream) return send(res, 400, '缺少 url 参数：/proxy?url=https://api.openai.com/v1&path=/chat/completions');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers.accept) headers.Accept = req.headers.accept;

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
  } catch (e) {
    return send(res, 502, '连不上上游：' + e.message);
  }

  const out = { ...CORS };
  const ct = upstreamRes.headers.get('content-type');
  if (ct) out['Content-Type'] = ct;
  out['Cache-Control'] = 'no-store';
  res.writeHead(upstreamRes.status, out);

  if (!upstreamRes.body) return res.end();
  // SSE 必须边收边吐，不能等整个响应
  const reader = upstreamRes.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (e) {
    /* 客户端断开是常态 */
  }
  res.end();
}

// packages/ui-dsl 是 TypeScript：浏览器拿到前先剥掉类型（只剥类型，不打包、不改 import）
const tsTranspiler = globalThis.Bun ? new Bun.Transpiler({ loader: 'ts' }) : null;

function serveStatic(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);
  const file = resolveRequest(pathname);
  if (!file) return send(res, 404, '404 ' + pathname);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '404 ' + pathname);
    const isTs = path.extname(file) === '.ts';
    if (isTs && !tsTranspiler) return send(res, 500, '.ts 需要用 bun 启动服务才能转译');
    const type = isTs ? MIME['.js'] : MIME[path.extname(file)] || 'application/octet-stream';
    // HTML 文档不能回 no-store：跨文档 View Transition 要求导航响应可缓存，
    // 否则浏览器直接跳过整次过渡（见 apps/web/src/motion.js）。
    // no-cache 仍然每次回源校验，开发时拿到的还是最新的；其余资源维持 no-store。
    const cache = type.startsWith('text/html') ? 'no-cache' : 'no-store';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': cache,
      ...CORS,
    });
    res.end(isTs ? tsTranspiler.transformSync(data.toString('utf8')) : data);
  });
}

/** 本机的局域网 IPv4（给手机 / 别的电脑访问用）；取不到就只报 127.0.0.1 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      // 169.254/16 是链路本地地址，198.18/15 常见于代理软件的 TUN 网卡，都不是真实局域网
      if (/^169\.254\./.test(it.address) || /^198\.(18|19)\./.test(it.address)) continue;
      out.push(it.address);
    }
  }
  return out;
}

http
  .createServer((req, res) => {
    if (req.url.startsWith(PROXY_PREFIX)) return handleProxy(req, res);
    if (req.url.startsWith(API_PREFIX)) return handleApi(req, res);
    serveStatic(req, res);
  })
  .listen(PORT, HOST, () => {
    const lan = HOST === '127.0.0.1' || HOST === 'localhost' ? [] : lanAddresses();
    console.log(`OpenUI Lab    http://127.0.0.1:${PORT}/`);
    for (const ip of lan) console.log(`  局域网访问  http://${ip}:${PORT}/`);
    console.log(`演示回放      http://127.0.0.1:${PORT}/demos.html`);
    console.log(`上游转发      http://127.0.0.1:${PORT}/proxy?url=<上游地址>`);
    console.log(`会话接口      http://127.0.0.1:${PORT}/api/conversations（库：${db.location() || '内存'}）`);
    console.log(`约定路径      /runner.html · /js/worker-runtime.js（兼容映射，调用端未改动）`);
  });
