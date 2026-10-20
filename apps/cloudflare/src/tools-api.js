// 联网工具：设置存 D1 app_setting.tools.config；执行走 Tavily / RSS / Jina / 自研抠正文。
// 逻辑对齐 apps/server/src/tools.mjs（Workers 无 Buffer，decode 用 atob）。

import { ApiError } from './errors.js';

const UA = 'openui-lab/0.3 (+tools; cloudflare)';
const SNIPPET_MAX = 180;
const FETCH_MAX = 4000;
const TIMEOUT_MS = 20_000;
const settingKey = (accountId) => `tools.config:${accountId}`;

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

function b64Utf8(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

async function loadSettings(db, env, accountId) {
  let saved = null;
  const row = await db.prepare('SELECT value FROM app_setting WHERE key = ?').bind(settingKey(accountId)).first();
  if (row?.value) {
    try {
      saved = JSON.parse(row.value);
    } catch {
      saved = null;
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
  const fromEnv = env?.TAVILY_API_KEY || '';
  return { tavilyKey: String((saved && saved.tavilyKey) || fromEnv || ''), tools };
}

async function saveSettings(db, accountId, snapshot) {
  await db
    .prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(settingKey(accountId), JSON.stringify(snapshot), Date.now())
    .run();
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' };

const stripMarkup = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi, (m) => ENT[m.toLowerCase()] || m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d) || 32));

function clean(s) {
  return stripMarkup(s).replace(/\s+/g, ' ').trim();
}

function cleanBlock(s) {
  return stripMarkup(s)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchText(url, { accept = 'text/html,*/*', timeout = TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new ApiError(502, `打不开 ${url}：${e.message}`);
  }
  if (!res.ok) throw new ApiError(502, `${url} 返回 ${res.status}`);
  return await res.text();
}

const tryText = (url, opts) => fetchText(url, opts).catch(() => null);

const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$)/i;

function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    throw new ApiError(400, 'URL 不合法');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ApiError(400, '只支持 http / https');
  if (PRIVATE_HOST.test(u.hostname)) throw new ApiError(403, '内网地址不允许访问');
  return u;
}

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

function unwrapResultUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const nested = u.searchParams.get('url');
    if (nested && /^https?:/i.test(nested)) return nested;
    const enc = u.searchParams.get('u');
    if (enc && /^a1/i.test(enc)) {
      const decoded = b64Utf8(enc.slice(2));
      if (/^https?:/i.test(decoded)) return decoded;
    }
  } catch {
    /* keep */
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
  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${Math.min(10, n + 2)}`, {
    accept: 'text/html,*/*',
  });
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
  const [news, gnews, web] = await Promise.all([
    bingNewsSearch(q, n, recency).catch(() => []),
    googleNewsSearch(q, n, recency).catch(() => []),
    bingWebHtml(q, n).catch(() => []),
  ]);
  const results = mergeHits([news, gnews, web], n);
  if (!results.length) {
    throw new ApiError(502, '搜索没返回结果（免费通道不稳；在设置 · 工具里填 Tavily Key 会稳得多）');
  }
  const engine = news.length ? 'bing-news' : gnews.length ? 'google-news' : 'bing';
  return { engine, results };
}

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

async function webSearch({ query, recency = 'week', maxResults = 4, tavilyKey = '' } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw new ApiError(400, 'query 不能为空');
  const n = Math.max(1, Math.min(8, Number(maxResults) || 4));
  const days = RECENCY_DAYS[recency] ?? RECENCY_DAYS.week;

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
    } catch {
      /* free fallback */
    }
  }
  const free = await freeSearch(q, n, recency);
  const out = { query: q, engine: free.engine, results: trimResults(free.results, n) };
  cachePut(key, out);
  return out;
}

function htmlToText(html, limit = FETCH_MAX) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');
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
  if (/\.(md|markdown|txt)$/i.test(u.pathname)) {
    const t = await tryText(u.href, { accept: 'text/plain,*/*' });
    if (t) return { url: u.href, via: 'raw', title: '', length: t.length, text: t.slice(0, limit) };
  }

  if (u.pathname === '/' || u.pathname === '') {
    const llm = await tryText(`${u.origin}/llms.txt`, { accept: 'text/plain,*/*' });
    if (llm && llm.length > 200) return { url: u.href, via: 'llms.txt', title: '', length: llm.length, text: llm.slice(0, limit) };
  }

  if (tavilyKey) {
    const t = await tavilyExtract(u.href, tavilyKey).catch(() => null);
    if (t && t.length > 200) return { url: u.href, via: 'tavily', title: '', length: t.length, text: t.slice(0, limit) };
  }

  const jina = await tryText(`https://r.jina.ai/${u.href}`, { accept: 'text/plain,*/*' });
  if (jina && jina.length > 200) return { url: u.href, via: 'jina', title: '', length: jina.length, text: jina.slice(0, limit) };

  const html = await fetchText(u.href);
  const text = htmlToText(html, limit);
  if (!text) throw new ApiError(502, '这个页面没抠出正文（多半是纯 JS 渲染的，得上无头浏览器）');
  return { url: u.href, via: 'html', title: titleOf(html), length: text.length, text };
}

async function fetchUrl({ url, maxChars = FETCH_MAX, tavilyKey = '' } = {}) {
  const u = assertPublicUrl(url);
  const limit = Math.max(500, Math.min(40_000, Number(maxChars) || FETCH_MAX));

  const key = `f|${limit}|${u.href}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const out = await readPage(u, limit, tavilyKey);
  cachePut(key, out);
  return out;
}

export async function handleTools(request, db, path, env, account) {
  const accountId = account.id;
  const method = request.method;
  const json = async () => {
    try {
      return await request.json();
    } catch {
      throw new ApiError(400, '请求体不是合法 JSON');
    }
  };

  if (method === 'GET' && path === '/tools') {
    return { status: 200, body: await loadSettings(db, env, accountId) };
  }

  if (method === 'PUT' && path === '/tools') {
    const patch = await json();
    const cur = await loadSettings(db, env, accountId);
    const tools = { ...cur.tools };
    for (const [id, v] of Object.entries(patch.tools || {})) {
      if (!tools[id] || !v) continue;
      const next = { ...tools[id] };
      if (v.enabled !== undefined) next.enabled = !!v.enabled;
      if (v.approval === 'ask' || v.approval === 'auto') next.approval = v.approval;
      tools[id] = next;
    }
    const next = {
      tavilyKey: patch.tavilyKey === undefined ? cur.tavilyKey : String(patch.tavilyKey || ''),
      tools,
    };
    await saveSettings(db, accountId, next);
    return { status: 200, body: next };
  }

  if (method === 'POST' && path === '/tools/web_search') {
    const s = await loadSettings(db, env, accountId);
    if (!s.tools.web_search?.enabled) throw new ApiError(403, '联网搜索已关闭（设置页 · 工具里打开）');
    const body = await json();
    return {
      status: 200,
      body: await webSearch({
        query: body.query,
        recency: body.recency,
        maxResults: body.maxResults,
        tavilyKey: s.tavilyKey,
      }),
    };
  }

  if (method === 'POST' && path === '/tools/fetch_url') {
    const s = await loadSettings(db, env, accountId);
    if (!s.tools.fetch_url?.enabled) throw new ApiError(403, '读取网页已关闭（设置页 · 工具里打开）');
    const body = await json();
    return {
      status: 200,
      body: await fetchUrl({ url: body.url, maxChars: body.maxChars, tavilyKey: s.tavilyKey }),
    };
  }

  throw new ApiError(404, '没有这个接口');
}
