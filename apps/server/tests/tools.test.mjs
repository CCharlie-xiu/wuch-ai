// 工具：只测不联网的那一半（正文提取、出网检查、设置存取）。
// 真正联网的部分要打第三方，放测试里会不稳，靠设置页的开关手动验。
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, RepoError } from '../src/db.mjs';
import { htmlToText, assertPublicUrl, createToolSettings, TOOL_META, unwrapResultUrl } from '../src/tools.mjs';

let db;
beforeEach(async () => {
  db = await openDb(':memory:');
});
afterEach(() => db.close());

test('正文提取：去掉脚本样式，只留文字', () => {
  const html = `<html><head><title>T</title><style>a{color:red}</style></head>
    <body><nav>导航</nav><article><h1>标题</h1><p>第一段。</p><script>x()</script><p>第二段。</p></article></body></html>`;
  const text = htmlToText(html);
  expect(text).not.toContain('color:red');
  expect(text).not.toContain('x()');
  expect(text).toContain('第一段');
  expect(text).toContain('第二段');
});

test('正文提取：正文够长时丢掉导航等外围', () => {
  const filler = '内容。'.repeat(200);
  const html = `<body><nav>导航导航</nav><article><p>${filler}</p></article><footer>页脚</footer></body>`;
  const text = htmlToText(html);
  expect(text).not.toContain('导航导航');
  expect(text).not.toContain('页脚');
});

test('正文提取：压掉多余空白并截断', () => {
  // 段间留一个空行，段落内的换行压掉
  expect(htmlToText('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
  expect(htmlToText('<p>' + 'x'.repeat(500) + '</p>', 100).length).toBe(100);
});

test('搜索结果 URL：解开必应新闻 / SERP 跳转', () => {
  expect(
    unwrapResultUrl(
      'http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fapnews.com%2farticle%2Fx&c=1&mkt=en-us',
    ),
  ).toBe('https://apnews.com/article/x');
  const enc = 'a1' + Buffer.from('https://www.typescriptlang.org/docs/').toString('base64');
  expect(unwrapResultUrl(`https://www.bing.com/ck/a?!&&p=x&u=${enc}&ntb=1`)).toBe('https://www.typescriptlang.org/docs/');
  expect(unwrapResultUrl('https://example.com/a')).toBe('https://example.com/a');
});

test('出网检查：拦掉内网与非 http', () => {
  expect(() => assertPublicUrl('http://127.0.0.1:8788/')).toThrow(RepoError);
  expect(() => assertPublicUrl('http://192.168.1.1/')).toThrow(RepoError);
  expect(() => assertPublicUrl('http://localhost/')).toThrow(RepoError);
  expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(RepoError);
  expect(() => assertPublicUrl('不是网址')).toThrow(RepoError);
  expect(assertPublicUrl('https://example.com/a').host).toBe('example.com');
});

test('工具设置：默认按 TOOL_META，改完能读回来', () => {
  const s = createToolSettings(db);
  const first = s.snapshot();
  expect(Object.keys(first.tools)).toEqual(TOOL_META.map((t) => t.id));
  expect(first.tools.web_search.approval).toBe('auto');
  expect(first.tools.fetch_url.approval).toBe('ask');

  const next = s.update({ tools: { fetch_url: { enabled: false, approval: 'auto' } }, tavilyKey: 'tvly-x' });
  expect(next.tools.fetch_url.enabled).toBe(false);
  expect(next.tools.fetch_url.approval).toBe('auto');
  expect(next.tavilyKey).toBe('tvly-x');

  // 换一个实例读（模拟重启），得和刚写的一致
  expect(createToolSettings(db).snapshot().tools.fetch_url).toEqual(next.tools.fetch_url);
  expect(createToolSettings(db).snapshot().tavilyKey).toBe('tvly-x');
});

test('工具设置：认不出的 id 和不合法的授权方式不改状态', () => {
  const s = createToolSettings(db);
  const out = s.update({ tools: { 不存在的: { enabled: false }, web_search: { approval: '随便' } } });
  expect(out.tools.web_search.approval).toBe('auto');
  expect(out.tools.web_search.enabled).toBe(true);
  expect(out.tools.不存在的).toBeUndefined();
});
