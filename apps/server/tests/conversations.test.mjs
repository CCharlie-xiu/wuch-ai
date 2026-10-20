import { test, expect, beforeEach, afterEach } from 'bun:test';
import http from 'node:http';
import * as XLSX from 'xlsx';
import { openDb, createConversationRepo } from '../src/db.mjs';
import { createApi } from '../src/api.mjs';

let server;
let base;

beforeEach(async () => {
  const db = await openDb(':memory:');
  const handleApi = createApi({ repo: createConversationRepo(db), db });
  server = http.createServer(handleApi);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterEach(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!(res.headers.get('content-type') || '').includes('json')) return { status: res.status, body: null, file: await res.arrayBuffer() };
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const turn = (userText, extra = {}) => ({ userText, raw: `root = Text("${userText}")`, state: 'complete', summary: [{ title: '界面已生成', text: '', refs: [] }], ...extra });

test('health', async () => {
  expect((await call('GET', '/health')).body).toEqual({ ok: true, db: 'ready', file: ':memory:', schemaVersion: 8 });
});

test('接口目录与路由表一致：每条都能按目录里的方法与路径命中', async () => {
  const { endpoints } = (await call('GET', '/endpoints')).body;
  expect(endpoints.map((e) => `${e.method} ${e.path}`)).toContain('POST /conversations/:id/turns');
  expect(endpoints.find((e) => e.path === '/conversations/:id/turns')).toMatchObject({ writes: true, params: ['id'] });
  expect(endpoints.find((e) => e.path === '/conversations' && e.method === 'GET').query.map((q) => q.name)).toEqual(['limit', 'before']);
  for (const e of endpoints) {
    const { status, body } = await call(e.method, e.path.replace(/:\w+/g, 'probe'), e.body || undefined);
    expect({ route: `${e.method} ${e.path}`, missed: status === 405 || body?.error === '没有这个接口' }).toEqual({ route: `${e.method} ${e.path}`, missed: false });
  }
});

test('第一轮建出会话，标题取第一句，轮次按 seq 递增', async () => {
  const a = await call('POST', '/conversations/c1/turns', turn('做一个仪表盘'));
  expect(a.status).toBe(201);
  expect(a.body.conversation).toMatchObject({ id: 'c1', title: '做一个仪表盘', turnCount: 1 });

  await call('POST', '/conversations/c1/turns', turn('加一个图表', { model: 'gpt-4o-mini' }));
  const { body } = await call('GET', '/conversations/c1');
  expect(body.conversation.turnCount).toBe(2);
  expect(body.conversation.turns.map((t) => [t.seq, t.userText, t.model])).toEqual([
    [1, '做一个仪表盘', null],
    [2, '加一个图表', 'gpt-4o-mini'],
  ]);
  expect(body.conversation.turns[0].summary).toEqual([{ title: '界面已生成', text: '', refs: [] }]);
});

test('标题不含附件正文：用户写了话就取那句话，只传文件就拿文件名', async () => {
  const sha = 'a'.repeat(64);
  const withFile = await call(
    'POST',
    '/conversations/c-file/turns',
    turn(`把这份文档收进知识库\n\n【文件 记忆系统规划.md｜sha256 ${sha}】\n# 记忆系统规划\n\n两万字正文…`),
  );
  expect(withFile.body.conversation.title).toBe('把这份文档收进知识库');

  const fileOnly = await call('POST', '/conversations/c-only/turns', turn(`【文件 记忆系统规划.md｜sha256 ${sha}】\n# 记忆系统规划`));
  expect(fileOnly.body.conversation.title).toBe('记忆系统规划.md');

  // 完整原文仍然存着 —— 标题只是显示用的那一份
  const { body } = await call('GET', '/conversations/c-file');
  expect(body.conversation.turns[0].userText).toContain('两万字正文');
});

test('history 只取完成的轮次，最多最近 4 轮', async () => {
  for (let i = 1; i <= 6; i++) await call('POST', '/conversations/c1/turns', turn(`第${i}轮`));
  await call('POST', '/conversations/c1/turns', turn('失败的一轮', { state: 'error', failure: '上游 500' }));
  const { history } = (await call('GET', '/conversations/c1')).body.conversation;
  expect(history.length).toBe(8);
  expect(history.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['第3轮', '第4轮', '第5轮', '第6轮']);
  expect(history[1]).toEqual({ role: 'assistant', content: 'root = Text("第3轮")' });
});

test('列表按最近更新倒序，删除后看不到也不能再追加', async () => {
  await call('POST', '/conversations/old/turns', turn('旧的'));
  await Bun.sleep(5);
  await call('POST', '/conversations/new/turns', turn('新的'));
  expect((await call('GET', '/conversations')).body.conversations.map((c) => c.id)).toEqual(['new', 'old']);

  expect((await call('DELETE', '/conversations/old')).status).toBe(204);
  expect((await call('GET', '/conversations')).body.conversations.map((c) => c.id)).toEqual(['new']);
  expect((await call('GET', '/conversations/old')).status).toBe(404);
  expect((await call('POST', '/conversations/old/turns', turn('复活'))).status).toBe(409);
});

test('改标题', async () => {
  await call('POST', '/conversations/c1/turns', turn('随便'));
  expect((await call('PATCH', '/conversations/c1', { title: '  新标题  ' })).status).toBe(204);
  expect((await call('GET', '/conversations/c1')).body.conversation.title).toBe('新标题');
  expect((await call('PATCH', '/conversations/nope', { title: 'x' })).status).toBe(404);
});

test('参数校验', async () => {
  expect((await call('POST', '/conversations/bad id!/turns', turn('x'))).status).toBe(400);
  expect((await call('POST', '/conversations/c1/turns', { userText: '', state: 'complete' })).status).toBe(400);
  expect((await call('POST', '/conversations/c1/turns', { userText: 'x', state: 'streaming' })).status).toBe(400);
  expect((await call('PUT', '/conversations/c1')).status).toBe(405);
  expect((await call('GET', '/nothing')).status).toBe(404);
});

test('导入浏览器旧会话：状态按 failure 还原，重复导入跳过', async () => {
  const legacy = [
    {
      id: 'lg1',
      title: '旧会话',
      createdAt: 1000,
      updatedAt: 2000,
      turns: [
        { user: '第一句', raw: 'a = 1', summary: [], failure: null, opts: { source: 'a = 1', bindings: {} } },
        { user: '第二句', raw: '', summary: [], failure: '已取消', opts: null },
        { user: '第三句', raw: '', summary: [], failure: '上游 500', opts: null },
      ],
      history: [],
    },
  ];
  expect((await call('POST', '/import/conversations', { conversations: legacy })).body).toEqual({ imported: 1, skipped: 0 });
  expect((await call('POST', '/import/conversations', { conversations: legacy })).body).toEqual({ imported: 0, skipped: 1 });

  const c = (await call('GET', '/conversations/lg1')).body.conversation;
  expect(c).toMatchObject({ title: '旧会话', turnCount: 3, updatedAt: 2000 });
  expect(c.turns.map((t) => t.state)).toEqual(['complete', 'cancelled', 'error']);
  expect(c.turns[0].replay).toEqual({ source: 'a = 1', bindings: {} });
  // 导入的旧会话串成一条链，HEAD 在最后一轮，快照沿用最后一次有原文的轮次
  expect(c.chain).toEqual(c.turns.map((t) => t.id));
  expect(c.headTurnId).toBe(c.turns[2].id);
  expect(c.turns.map((t) => [t.depth, t.snapshot])).toEqual([[1, 'a = 1'], [2, 'a = 1'], [3, 'a = 1']]);
});

// ── 版本树：HEAD / 回退 / 前进 / 分支 ─────────────────────────────────────

const head = (id, op, turnId) => call('POST', `/conversations/${id}/head`, { op, turnId });
const ids = (c, key) => c[key].map((tid) => c.turns.find((t) => t.id === tid).userText);

test('追加的轮次连成链，HEAD 跟着走；快照与 raw 分开存', async () => {
  await call('POST', '/conversations/c1/turns', turn('一'));
  const b = await call('POST', '/conversations/c1/turns', turn('二', { mode: 'edit', raw: 'x = 1', snapshot: 'root = Text("一")\nx = 1' }));
  expect(b.body.turn).toMatchObject({ depth: 2, mode: 'edit', raw: 'x = 1', snapshot: 'root = Text("一")\nx = 1' });
  const c = (await call('GET', '/conversations/c1')).body.conversation;
  expect(c.headTurnId).toBe(b.body.turnId);
  expect(ids(c, 'path')).toEqual(['一', '二']);
  expect(c.turns[0].activeChildId).toBe(b.body.turnId);
});

test('回退 / 前进；到头了 409；回退后发消息长出分支，兄弟可切换', async () => {
  for (const t of ['一', '二', '三']) await call('POST', '/conversations/c1/turns', turn(t));
  let c = (await head('c1', 'back')).body.conversation;
  expect(ids(c, 'path')).toEqual(['一', '二']);
  expect(ids(c, 'chain')).toEqual(['一', '二', '三']); // HEAD 之后的仍在 chain 里（界面置灰）
  expect(c.history.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['一', '二']); // 上下文跟着 HEAD
  c = (await head('c1', 'forward')).body.conversation;
  expect(ids(c, 'path')).toEqual(['一', '二', '三']);
  expect((await head('c1', 'forward')).status).toBe(409);
  await head('c1', 'back');
  await head('c1', 'back');
  expect((await head('c1', 'back')).status).toBe(409);

  // 停在「一」发新消息：从「一」长出「二'」，旧的「二 → 三」保留为另一支
  const fork = await call('POST', '/conversations/c1/turns', turn("二'"));
  expect(fork.body.turn.depth).toBe(2);
  c = (await call('GET', '/conversations/c1')).body.conversation;
  expect(ids(c, 'chain')).toEqual(['一', "二'"]);
  const two = c.turns.find((t) => t.userText === '二');
  expect(c.turns.find((t) => t.userText === "二'").siblings).toEqual([two.id, fork.body.turnId]);

  // 切回旧分支：HEAD 落到那一支的最新一轮
  c = (await head('c1', 'switch', two.id)).body.conversation;
  expect(ids(c, 'path')).toEqual(['一', '二', '三']);
  // 直接跳到新分支的某一轮
  c = (await head('c1', 'checkout', fork.body.turnId)).body.conversation;
  expect(ids(c, 'chain')).toEqual(['一', "二'"]);

  const log = (await call('GET', '/conversations/c1/head-log')).body.log.map((l) => l.op);
  expect(log.slice(0, 3)).toEqual(['checkout', 'switch', 'commit']);
  expect((await head('c1', 'jump')).status).toBe(400);
  expect((await head('c1', 'checkout', 'nope')).status).toBe(404);
  expect((await head('nope', 'back')).status).toBe(404);
});

test('refs 在父节点基础上继承覆盖；指定 parentId 必须属于本会话', async () => {
  await call('POST', '/conversations/c1/turns', turn('一', { refs: { ds_aaaa: 'dv_1111' } }));
  const b = await call('POST', '/conversations/c1/turns', turn('二', { refs: { ds_bbbb: 'dv_2222' }, skills: ['sheet'] }));
  expect(b.body.turn.refs).toEqual({ ds_aaaa: 'dv_1111', ds_bbbb: 'dv_2222' });
  expect(b.body.turn.skills).toEqual(['sheet']);
  expect((await call('POST', '/conversations/c1/turns', turn('三', { parentId: 'nope' }))).status).toBe(400);
  expect((await call('POST', '/conversations/c1/turns', turn('三', { mode: 'magic' }))).status).toBe(400);
});

// ── 技能 ───────────────────────────────────────────────────────────────────

test('技能目录与会话里选中的技能', async () => {
  expect((await call('GET', '/skills')).body.skills.map((s) => s.id)).toEqual(['canvas', 'sheet']);
  expect((await call('PUT', '/conversations/c1/skills', { skills: ['sheet'] })).status).toBe(404); // 会话还没建
  await call('POST', '/conversations/c1/turns', turn('一'));
  expect((await call('PUT', '/conversations/c1/skills', { skills: ['sheet', 'canvas'] })).status).toBe(204);
  expect((await call('GET', '/conversations/c1/skills')).body.skills).toEqual(['sheet', 'canvas']);
  expect((await call('PUT', '/conversations/c1/skills', { skills: ['nope'] })).status).toBe(400);
  expect((await call('PUT', '/conversations/c1/skills', { skills: [] })).status).toBe(204);
  expect((await call('GET', '/conversations/c1/skills')).body.skills).toEqual([]);
});

// ── 数据集 / xlsx ──────────────────────────────────────────────────────────

const workbook = () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['月份', '销量'],
    ['1月', 10],
    ['2月', 20],
  ]);
  ws.C1 = { t: 's', v: '合计' };
  ws.C2 = { t: 'n', f: 'SUM(B2:B3)', v: 30 };
  ws['!ref'] = 'A1:C3';
  XLSX.utils.book_append_sheet(wb, ws, '销售');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

test('导入 xlsx：公式原样保留，原文件存进 blob；导出能读回来', async () => {
  await call('POST', '/conversations/c1/turns', turn('一'));
  const res = await fetch(`${base}/datasets/import?name=${encodeURIComponent('销售.xlsx')}&conversationId=c1`, { method: 'POST', body: workbook() });
  expect(res.status).toBe(201);
  const out = await res.json();
  expect(out.dataset).toMatchObject({ name: '销售', conversationId: 'c1', sourceName: '销售.xlsx', hasSource: true });
  expect(out.dataset.id).toMatch(/^ds_/);
  expect(out.version).toMatchObject({ author: 'import', parentId: null });
  expect(out.data.sheets[0]).toEqual({ name: '销售', cells: [['月份', '销量', '合计'], ['1月', 10, '=SUM(B2:B3)'], ['2月', 20]] });
  expect((await call('GET', '/conversations/c1/datasets')).body.datasets.map((d) => d.id)).toEqual([out.dataset.id]);

  const file = await fetch(`${base}/datasets/${out.dataset.id}/export?format=xlsx`);
  expect(file.headers.get('content-disposition')).toContain("filename*=UTF-8''%E9%94%80%E5%94%AE.xlsx");
  const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer', cellFormula: true });
  expect(wb.Sheets['销售'].C2.f).toBe('SUM(B2:B3)');
  expect(wb.Sheets['销售'].B3.v).toBe(20);

  const csv = await (await fetch(`${base}/datasets/${out.dataset.id}/export?format=csv`)).text();
  expect(csv.replace(/^\ufeff/, '').split('\n')[0]).toBe('月份,销量,合计');
});

test('数据集版本是链：提交新版本、按版本读取，旧版本不变', async () => {
  const created = await call('POST', '/datasets', { name: '表', data: { sheets: [{ name: 'S', cells: [['a'], [1]] }] }, author: 'user' });
  expect(created.status).toBe(201);
  const ds = created.body.dataset.id;
  const v1 = created.body.version.id;
  const v2 = (await call('POST', `/datasets/${ds}/versions`, { parentId: v1, data: { sheets: [{ name: 'S', cells: [['a'], [2]] }] }, author: 'user', note: '改成 2' })).body.version;
  expect(v2).toMatchObject({ parentId: v1, author: 'user', note: '改成 2' });
  expect((await call('GET', `/datasets/${ds}/data?version=${v1}`)).body.data.sheets[0].cells).toEqual([['a'], [1]]);
  expect((await call('GET', `/datasets/${ds}/data`)).body.data.sheets[0].cells).toEqual([['a'], [2]]);
  expect((await call('GET', `/datasets/${ds}`)).body.dataset.versions.map((v) => v.id)).toEqual([v1, v2.id]);
  expect((await call('POST', `/datasets/${ds}/versions`, { parentId: 'dv_nope', data: { sheets: [{ name: 'S', cells: [] }] } })).status).toBe(400);
  expect((await call('POST', `/datasets/${ds}/versions`, { data: { sheets: [{ name: 'S', cells: [[{ x: 1 }]] }] } })).status).toBe(400);
  expect((await call('GET', '/datasets/ds_nope0000')).status).toBe(404);
});

test('导入格式与大小校验；页面表格直接导出', async () => {
  expect((await fetch(`${base}/datasets/import?name=a.pdf`, { method: 'POST', body: 'x' })).status).toBe(415);
  expect((await fetch(`${base}/datasets/import?name=a.csv`, { method: 'POST', body: '' })).status).toBe(400);
  const csvIn = await fetch(`${base}/datasets/import?name=a.csv`, { method: 'POST', body: '\ufeff月份,销量\n1月,2\n' });
  expect((await csvIn.json()).data.sheets[0].cells).toEqual([['月份', '销量'], ['1月', 2]]);

  const res = await fetch(`${base}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '内联表', format: 'xlsx', sheets: [{ name: 'S', cells: [['a', 'b'], [1, '=A2*2']] }], values: [[['a', 'b'], [1, 2]]] }),
  });
  expect(res.status).toBe(200);
  const ws = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer', cellFormula: true }).Sheets.S;
  expect([ws.B2.f, ws.B2.v]).toEqual(['A2*2', 2]);
});

// ── 模型配置 ───────────────────────────────────────────────────────────────

const mkModel = (extra = {}) => ({ name: 'DeepSeek', provider: 'DeepSeek', baseURL: 'https://api.deepseek.com/', apiKey: 'sk-1', model: 'deepseek-chat', temperature: 0.6, thinking: true, ...extra });

test('模型配置：第一个建出来就自动成为当前，地址去掉尾斜杠', async () => {
  expect((await call('GET', '/models')).body).toEqual({ models: [], activeId: null });

  const a = await call('POST', '/models', mkModel());
  expect(a.status).toBe(201);
  expect(a.body.model).toMatchObject({ name: 'DeepSeek', provider: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 0.6, thinking: true, enabled: true });
  expect(a.body.model.id).toMatch(/^m_/);

  const b = await call('POST', '/models', mkModel({ name: '本地 mock', provider: '本地', baseURL: 'http://127.0.0.1:8789/v1', apiKey: '', model: 'mock' }));
  const snap = (await call('GET', '/models')).body;
  expect(snap.models.map((m) => m.name)).toEqual(['DeepSeek', '本地 mock']);
  expect(snap.activeId).toBe(a.body.model.id);
  expect(b.body.model.temperature).toBe(0.6);
});

test('模型配置：改名 / 换地址 / 开关，关掉当前那个会自动落到下一个开着的', async () => {
  const a = (await call('POST', '/models', mkModel())).body.model;
  const b = (await call('POST', '/models', mkModel({ name: '备选', enabled: true }))).body.model;

  const renamed = await call('PATCH', `/models/${a.id}`, { name: 'DeepSeek 快版', baseURL: 'http://127.0.0.1:8788/proxy?url=https://api.deepseek.com' });
  expect(renamed.body.model).toMatchObject({ name: 'DeepSeek 快版', baseURL: 'http://127.0.0.1:8788/proxy?url=https://api.deepseek.com', model: 'deepseek-chat' });

  // 当前是 a，把 a 关掉 → 自动切到 b
  expect((await call('PATCH', `/models/${a.id}`, { enabled: false })).body.model.enabled).toBe(false);
  expect((await call('GET', '/models')).body.activeId).toBe(b.id);
  // 关掉的不能切过去
  expect((await call('POST', `/models/${a.id}/activate`)).status).toBe(409);
  // 删掉当前那个 → 落到第一个开着的；一个都不剩就置空
  expect((await call('DELETE', `/models/${b.id}`)).status).toBe(204);
  expect((await call('GET', '/models')).body.activeId).toBeNull();
  expect((await call('PATCH', '/models/m_nope0000', { name: 'x' })).status).toBe(404);
  expect((await call('POST', '/models', { name: '  ' })).status).toBe(400);
});
