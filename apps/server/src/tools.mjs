// ─────────────────────────────────────────────────────────────────────────────
// 工具：给模型的联网能力。
//
//   web_search  搜关键词 → 几条「标题 + 链接 + 摘录」，不给整页
//   fetch_url   读一个网页 → 清洗过的正文，不给 HTML
//
// 两个都只读。fetch 拿到的只是 HTML 文本，不会下载 CSS / JS / 图片，也不执行脚本。
// 正文提取按「便宜的先试」降级：llms.txt / .md → Tavily → Jina Reader → 自己抠。
//
// 设置（开关 / 授权方式 / Tavily Key）存在 app_setting 的 tools.config 里。
// ─────────────────────────────────────────────────────────────────────────────

import { RepoError } from './db.mjs';

const UA = 'openui-lab/0.3 (+tools)';
const SNIPPET_MAX = 180; // 每条摘录的字数：够模型判断要不要展开，又不至于堆 token
const FETCH_MAX = 4000; // 网页正文的字数上限
const TIMEOUT_MS = 20_000;

// ── 缓存 ────────────────────────────────────────────────────────────────────
// 同一个词 / 同一个网址在短时间内被问两次很常见（模型换词重搜、一轮里画界面又问一遍），
// 缓存住既省第三方额度，也省一次网络往返。
const CACHE_TTL = 5 * 60_000;
const CACHE_MAX = 100;
const RESULT_CACHE = new Map();
const cacheGet = (k) => {
  const v = RESULT_CACHE.get(k);
  if (!v) return null;
  if (Date.now() - v.at > CACHE_TTL) {
    RESULT_CACHE.delete(k);
    return null;
  }
  return v.val;
};
const cachePut = (k, val) => {
  RESULT_CACHE.set(k, { at: Date.now(), val });
  if (RESULT_CACHE.size > CACHE_MAX) RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
};

// ── 工具目录 ────────────────────────────────────────────────────────────────
// approval: auto 直接调 / ask 调用前先问用户
export const TOOL_META = [
  {
    id: 'web_search',
    name: '联网搜索',
    summary: '搜关键词，返回标题 + 链接 + 摘录',
    risk: 'low',
    approval: 'auto',
    enabled: true,
  },
  {
    id: 'fetch_url',
    name: '读取网页',
    summary: '打开一个网址，只取正文',
    risk: 'medium',
    approval: 'ask',
    enabled: true,
  },
  // 知识库（AOCI）：查 / 存 / 读。执行在 /api/kb/*（见 apps/server/src/kb.mjs）。
  // kb_put 会改数据，默认「每次询问」；另外两个只读。
  {
    id: 'kb_lookup',
    name: '查知识库',
    summary: '入库前先查有没有（按文件 hash / 标题 / 摘要去重），命中连正文一起返回',
    risk: 'low',
    approval: 'auto',
    enabled: true,
  },
  {
    id: 'kb_put',
    name: '存入知识库',
    summary: '把蒸馏后的条目写进知识库（会改数据）',
    risk: 'medium',
    approval: 'ask',
    enabled: true,
  },
  {
    id: 'kb_get',
    name: '读知识库条目',
    summary: '按 id 读一条知识条目的正文',
    risk: 'low',
    approval: 'auto',
    enabled: true,
  },
];

// ── 设置 ────────────────────────────────────────────────────────────────────
const SETTING_KEY = 'tools.config';

export function createToolSettings(db = null) {
  const q = db
    ? {
        get: db.prepare('SELECT value FROM app_setting WHERE key = ?'),
        put: db.prepare(
          `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ),
      }
    : null;

  function load() {
    let saved = null;
    if (q) {
      const row = q.get.get(SETTING_KEY);
      if (row && row.value) {
        try {
          saved = JSON.parse(row.value);
        } catch (e) {
          saved = null;
        }
      }
    }
    const tools = {};
    for (const t of TOOL_META) {
      const s = (saved && saved.tools && saved.tools[t.id]) || {};
      tools[t.id] = {
        id: t.id,
        name: t.name,
        summary: t.summary,
        risk: t.risk,
        enabled: s.enabled !== false,
        approval: s.approval === 'ask' || s.approval === 'auto' ? s.approval : t.approval,
      };
    }
    return { tavilyKey: String((saved && saved.tavilyKey) || process.env.TAVILY_API_KEY || ''), tools };
  }

  let cache = null;

  return {
    snapshot() {
      if (!cache) cache = load();
      return cache;
    },
    update(patch = {}) {
      const cur = this.snapshot();
      const tools = { ...cur.tools };
      for (const [id, v] of Object.entries(patch.tools || {})) {
        if (!tools[id] || !v) continue;
        const next = { ...tools[id] };
        if (v.enabled !== undefined) next.enabled = !!v.enabled;
        if (v.approval === 'ask' || v.approval === 'auto') next.approval = v.approval;
        tools[id] = next;
      }
      cache = { tavilyKey: patch.tavilyKey === undefined ? cur.tavilyKey : String(patch.tavilyKey || ''), tools };
      if (q) q.put.run(SETTING_KEY, JSON.stringify(cache), Date.now());
      return cache;
    },
  };
}

// ── 清洗 ────────────────────────────────────────────────────────────────────
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' };

const stripMarkup = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi, (m) => ENT[m.toLowerCase()] || m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d) || 32));

/** 压成一行：给搜索摘录用 */
function clean(s) {
  return stripMarkup(s).replace(/\s+/g, ' ').trim();
}

/** 保留段落换行：给网页正文用 */
function cleanBlock(s) {
  return stripMarkup(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 抓一段文本；失败抛 RepoError（调用方决定要不要兜底） */
async function fetchText(url, { accept = 'text/html,*/*', timeout = TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new RepoError(502, `打不开 ${url}：${e.message}`);
  }
  if (!res.ok) throw new RepoError(502, `${url} 返回 ${res.status}`);
  return await res.text();
}

/** 抓一段文本；失败返回 null，给降级链用 */
const tryText = (url, opts) => fetchText(url, opts).catch(() => null);

// ── 出网前的安全检查 ────────────────────────────────────────────────────────
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$)/i;

export function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch (e) {
    throw new RepoError(400, 'URL 不合法');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RepoError(400, '只支持 http / https');
  if (PRIVATE_HOST.test(u.hostname)) throw new RepoError(403, '内网地址不允许访问');
  return u;
}

// ── 联网搜索 ────────────────────────────────────────────────────────────────
const RECENCY_DAYS = { day: 1, week: 7, month: 30, any: 0 };

const toHit = (x) => ({
  title: clean(x.title).slice(0, 160),
  url: String(x.url || ''),
  snippet: clean(x.content ?? x.snippet).slice(0, SNIPPET_MAX),
});

async function tavilySearch(q, n, days, key) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, search_depth: 'basic', max_results: n, ...(days ? { days } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const j = await res.json();
  return (j.results || []).slice(0, n).map(toHit);
}

/** 必应 / Google 的跳转链解出真实 URL（新闻 apiclick、网页 SERP 的 u=a1+base64） */
export function unwrapResultUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const nested = u.searchParams.get('url');
    if (nested && /^https?:/i.test(nested)) return nested;
    const enc = u.searchParams.get('u');
    if (enc && /^a1/i.test(enc)) {
      const decoded = Buffer.from(enc.slice(2), 'base64').toString('utf8');
      if (/^https?:/i.test(decoded)) return decoded;
    }
  } catch (e) {
    /* 原样返回 */
  }
  return s;
}

function parseRss(xml, n) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && out.length < n) {
    const pick = (tag) => clean((new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(m[1]) || [])[1]);
    const title = pick('title');
    const url = unwrapResultUrl(pick('link'));
    if (!title || !/^https?:/i.test(url)) continue;
    const dated = pick('pubDate');
    const snippet = [dated, pick('description')].filter(Boolean).join(' · ').slice(0, SNIPPET_MAX);
    out.push({ title, url, snippet });
  }
  return out;
}

function mergeHits(lists, n) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const hit of list || []) {
      const key = hit.url.replace(/#.*$/, '').replace(/\/$/, '');
      if (!hit.url || seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
      if (out.length >= n) return out;
    }
  }
  return out;
}

// 必应网页版 format=rss 已基本失效（常吐首页/百科），免费通道改走：
//   1) 必应新闻 RSS（时效查询主力）
//   2) Google 新闻 RSS
//   3) 必应网页 HTML（文档 / 通用检索）
const BING_NEWS_INTERVAL = { day: '24', week: '7', month: '30' };
const GOOGLE_WHEN = { day: 'when:1d', week: 'when:7d', month: 'when:30d' };

async function bingNewsSearch(q, n, recency) {
  const interval = BING_NEWS_INTERVAL[recency];
  const url =
    `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss` +
    (interval ? `&qft=${encodeURIComponent(`interval="${interval}"`)}` : '');
  const xml = await fetchText(url, { accept: 'application/rss+xml,text/xml,*/*' });
  return parseRss(xml, n);
}

async function googleNewsSearch(q, n, recency) {
  const zh = /[\u4e00-\u9fff]/.test(q);
  const when = GOOGLE_WHEN[recency] || '';
  const qq = when ? `${q} ${when}` : q;
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(qq)}` +
    `&hl=${zh ? 'zh-CN' : 'en-US'}&gl=${zh ? 'CN' : 'US'}&ceid=${encodeURIComponent(zh ? 'CN:zh-Hans' : 'US:en')}`;
  const xml = await fetchText(url, { accept: 'application/rss+xml,text/xml,*/*' });
  return parseRss(xml, n);
}

async function bingWebHtml(q, n) {
  const html = await fetchText(
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${Math.min(10, n + 2)}`,
    { accept: 'text/html,*/*' },
  );
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m;
  while ((m = re.exec(html)) !== null && out.length < n) {
    const block = m[0];
    const a = /<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const url = unwrapResultUrl(a[1].replace(/&amp;/g, '&'));
    const title = clean(a[2]);
    if (!title || !/^https?:/i.test(url)) continue;
    if (/bing\.com\/(search|news|videos|images)/i.test(url)) continue;
    const sn =
      /class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block) ||
      /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({ title: title.slice(0, 160), url, snippet: clean(sn?.[1] || '').slice(0, SNIPPET_MAX) });
  }
  return out;
}

async function freeSearch(q, n, recency) {
  const tries = [];
  // 新闻通道：时效问题（融资、发布、新闻）靠它；网页 RSS 已废
  tries.push(bingNewsSearch(q, n, recency).catch(() => []));
  tries.push(googleNewsSearch(q, n, recency).catch(() => []));
  tries.push(bingWebHtml(q, n).catch(() => []));
  const [news, gnews, web] = await Promise.all(tries);
  const results = mergeHits([news, gnews, web], n);
  if (!results.length) {
    throw new RepoError(502, '搜索没返回结果（免费通道不稳；在设置 · 工具里填 Tavily Key 会稳得多）');
  }
  const engine = news.length ? 'bing-news' : gnews.length ? 'google-news' : 'bing';
  return { engine, results };
}

/** 丢掉没有摘录的（塞进上下文只是白烧 token），条数封顶 */
function trimResults(list, n) {
  const seen = new Set();
  const out = [];
  for (const r of list || []) {
    if (!r || !r.url || !r.title || !r.snippet) continue;
    const key = r.url.replace(/#.*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

export async function webSearch({ query, recency = 'week', maxResults = 4, tavilyKey = '' } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw new RepoError(400, 'query 不能为空');
  const n = Math.max(1, Math.min(8, Number(maxResults) || 4));
  const days = RECENCY_DAYS[recency] ?? RECENCY_DAYS.week;

  // 同一个词短时间被问两次很常见（模型换词重搜、一轮里画界面又来一遍）
  const key = `s|${recency}|${n}|${q}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  if (tavilyKey) {
    try {
      const results = trimResults(await tavilySearch(q, n, days, tavilyKey), n);
      if (results.length) {
        const out = { query: q, engine: 'tavily', results };
        cachePut(key, out);
        return out;
      }
    } catch (e) {
      /* 落到免费通道 */
    }
  }
  const free = await freeSearch(q, n, recency);
  const out = { query: q, engine: free.engine, results: trimResults(free.results, n) };
  cachePut(key, out);
  return out;
}

// ── 读取网页 ────────────────────────────────────────────────────────────────
/** HTML → 正文：去脚本样式，块级标签换行，压空白。不解析资源，只是文本替换 */
export function htmlToText(html, limit = FETCH_MAX) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');
  // 正文常在 <article> / <main> 里，取到了就只留它
  const body = /<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i.exec(s);
  if (body && body[1].length > 400) s = body[1];
  s = s
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article|td)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return cleanBlock(s).slice(0, limit);
}

const titleOf = (html) => clean((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '').slice(0, 160);

async function tavilyExtract(url, key) {
  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls: [url] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const raw = j.results?.[0]?.raw_content || j.results?.[0]?.content;
  return raw ? String(raw) : null;
}

async function readPage(u, limit, tavilyKey) {
  // 1. 本来就是纯文本
  if (/\.(md|markdown|txt)$/i.test(u.pathname)) {
    const t = await tryText(u.href, { accept: 'text/plain,*/*' });
    if (t) return { url: u.href, via: 'raw', title: '', length: t.length, text: t.slice(0, limit) };
  }

  // 2. 站点给 LLM 准备的精简版
  if (u.pathname === '/' || u.pathname === '') {
    const llm = await tryText(`${u.origin}/llms.txt`, { accept: 'text/plain,*/*' });
    if (llm && llm.length > 200) return { url: u.href, via: 'llms.txt', title: '', length: llm.length, text: llm.slice(0, limit) };
  }

  // 3. Tavily extract（有 Key 时）
  if (tavilyKey) {
    const t = await tavilyExtract(u.href, tavilyKey).catch(() => null);
    if (t && t.length > 200) return { url: u.href, via: 'tavily', title: '', length: t.length, text: t.slice(0, limit) };
  }

  // 4. Jina Reader：免费，直接给 markdown
  const jina = await tryText(`https://r.jina.ai/${u.href}`, { accept: 'text/plain,*/*' });
  if (jina && jina.length > 200) return { url: u.href, via: 'jina', title: '', length: jina.length, text: jina.slice(0, limit) };

  // 5. 自己抠
  const html = await fetchText(u.href);
  const text = htmlToText(html, limit);
  if (!text) throw new RepoError(502, '这个页面没抠出正文（多半是纯 JS 渲染的，得上无头浏览器）');
  return { url: u.href, via: 'html', title: titleOf(html), length: text.length, text };
}

export async function fetchUrl({ url, maxChars = FETCH_MAX, tavilyKey = '' } = {}) {
  const u = assertPublicUrl(url);
  const limit = Math.max(500, Math.min(40_000, Number(maxChars) || FETCH_MAX));

  const key = `f|${limit}|${u.href}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const out = await readPage(u, limit, tavilyKey);
  cachePut(key, out);
  return out;
}
