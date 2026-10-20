// 把完整前端打进 public/：apps/web + packages + vendor，并剥掉 ui-dsl 的 .ts 类型。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CF = path.resolve(HERE, '..');
const ROOT = path.resolve(CF, '../..');
const WEB = path.join(ROOT, 'apps', 'web');
const OUT = path.join(CF, 'public');

const requireFrom = (pkgJson) => createRequire(pathToFileURL(pkgJson));

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest, { filter } = {}) {
  mkdirp(dest);
  for (const name of fs.readdirSync(src)) {
    if (name === 'node_modules' || name === '.DS_Store') continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to, { filter });
    else if (!filter || filter(from, name)) fs.copyFileSync(from, to);
  }
}

function rewriteImportMaps(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.html')) continue;
    const file = path.join(dir, name);
    let html = fs.readFileSync(file, 'utf8');
    html = html.replaceAll('/packages/ui-dsl/src/index.ts', '/packages/ui-dsl/src/index.js');
    fs.writeFileSync(file, html);
  }
}

async function transpileUiDsl(srcDir) {
  if (!globalThis.Bun) throw new Error('stage-app 需要 bun（剥 .ts 类型）');
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) {
        const code = transpiler.transformSync(fs.readFileSync(full, 'utf8'));
        const out = full.replace(/\.ts$/, '.js');
        fs.writeFileSync(out, code);
        fs.unlinkSync(full);
      }
    }
  };
  walk(srcDir);
  // 改写同目录内 .ts 后缀的相对 import
  const fixImports = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) fixImports(full);
      else if (name.endsWith('.js')) {
        let text = fs.readFileSync(full, 'utf8');
        const next = text.replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2');
        if (next !== text) fs.writeFileSync(full, next);
      }
    }
  };
  fixImports(srcDir);
}

function linkOrCopy(src, dest) {
  mkdirp(path.dirname(dest));
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch {
    /* */
  }
  try {
    fs.symlinkSync(src, dest, 'junction');
  } catch {
    if (fs.statSync(src).isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

function stageVendors() {
  const catalogReq = requireFrom(path.join(ROOT, 'packages', 'catalog', 'package.json'));
  const webReq = requireFrom(path.join(WEB, 'package.json'));

  const echarts = catalogReq.resolve('echarts/dist/echarts.esm.min.mjs');
  fs.copyFileSync(echarts, path.join(OUT, 'vendor', 'echarts.js'));

  const markedDir = path.dirname(catalogReq.resolve('marked'));
  fs.copyFileSync(path.join(markedDir, 'marked.esm.js'), path.join(OUT, 'vendor', 'marked.js'));

  const katexDir = path.dirname(catalogReq.resolve('katex/dist/katex.mjs'));
  copyDir(katexDir, path.join(OUT, 'vendor', 'katex'));

  const hljsRoot = path.dirname(catalogReq.resolve('@highlightjs/cdn-assets/package.json'));
  // 只要 es 构建
  const hljsEs = path.join(hljsRoot, 'es');
  if (fs.existsSync(hljsEs)) copyDir(hljsEs, path.join(OUT, 'vendor', 'hljs'));
  else copyDir(hljsRoot, path.join(OUT, 'vendor', 'hljs'));

  const fontPkg = path.dirname(webReq.resolve('lxgw-wenkai-screen-webfont/package.json'));
  copyDir(fontPkg, path.join(OUT, 'vendor', 'fonts', 'lxgw-wenkai'));
}

async function main() {
  console.log('staging app →', OUT);
  rmrf(OUT);
  mkdirp(OUT);
  mkdirp(path.join(OUT, 'vendor'));

  // web 根：html / css / src / public
  for (const name of fs.readdirSync(WEB)) {
    if (name === 'node_modules' || name === 'package.json') continue;
    const from = path.join(WEB, name);
    const to = path.join(OUT, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }

  // 约定路径
  if (fs.existsSync(path.join(OUT, 'public', 'runner.html'))) {
    fs.copyFileSync(path.join(OUT, 'public', 'runner.html'), path.join(OUT, 'runner.html'));
  }

  // packages
  copyDir(path.join(ROOT, 'packages'), path.join(OUT, 'packages'), {
    filter: (_full, name) => !name.endsWith('.test.ts') && !name.endsWith('.test.js'),
  });

  // runtime 约定路径
  const runtime = path.join(OUT, 'packages', 'runtime', 'src', 'worker-runtime.js');
  if (fs.existsSync(runtime)) {
    mkdirp(path.join(OUT, 'js'));
    fs.copyFileSync(runtime, path.join(OUT, 'js', 'worker-runtime.js'));
  }

  await transpileUiDsl(path.join(OUT, 'packages', 'ui-dsl'));
  rewriteImportMaps(OUT);
  stageVendors();

  // 登录别名
  if (fs.existsSync(path.join(OUT, 'login.html'))) {
    // Workers assets 不自动做 /login → login.html；放一份无后缀用 Worker 补，或复制
  }

  console.log('done. files:', countFiles(OUT));
}

function countFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    n += fs.statSync(full).isDirectory() ? countFiles(full) : 1;
  }
  return n;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
