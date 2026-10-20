import { test, expect, beforeEach, afterEach } from 'bun:test';
import http from 'node:http';
import { openDb, createConversationRepo } from '../src/db.mjs';
import { createApi } from '../src/api.mjs';
import { dedupKeys } from '../src/kb.mjs';

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
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('去重键按 file → title → summary 排，非法 hash 不进键', () => {
  expect(dedupKeys({ fileHash: 'A'.repeat(64), title: '灰度发布' })).toEqual(['file:' + 'a'.repeat(64), 'title:灰度发布']);
  expect(dedupKeys({ fileHash: '短', title: '灰度发布' })).toEqual(['title:灰度发布']);
  expect(dedupKeys({})).toEqual([]);
});

test('入库后按标题命中，正文一起返回，命中数 +1', async () => {
  const a = await call('POST', '/kb/items', {
    name: '灰度发布流程',
    tag: '流程+发布',
    summary: '按 1% → 10% → 100% 放量',
    body: '## 何时用\n要上线新版本时',
  });
  expect(a.status).toBe(201);
  expect(a.body.created).toBe(true);
  expect(a.body.item.id).toMatch(/^kb_/);

  const l = await call('POST', '/kb/lookup', { title: '灰度发布流程' });
  expect(l.body.hit).toBe(true);
  expect(l.body.reason).toBe('title');
  expect(l.body.body).toContain('何时用');
  expect(l.body.item.hitCount).toBe(1);
});

test('同一标题再入库不重复建，直接返回已有条目', async () => {
  const a = await call('POST', '/kb/items', { name: '灰度发布流程', summary: '一句话', body: 'x' });
  const b = await call('POST', '/kb/items', { name: '灰度发布流程', summary: '另一句', body: 'y' });
  expect(b.body.created).toBe(false);
  expect(b.body.item.id).toBe(a.body.item.id);
  expect((await call('GET', '/kb/items')).body.items.length).toBe(1);
});

test('文件 hash 优先于标题命中', async () => {
  const h = 'a'.repeat(64);
  await call('POST', '/kb/items', { name: '文档 A', body: 'x', evidence: { fileHash: h, fileName: 'a.md' } });
  const l = await call('POST', '/kb/lookup', { fileHash: h, title: '文档 B' });
  expect(l.body.reason).toBe('file');
});

test('检索只扫索引列；正文要用单条接口取', async () => {
  await call('POST', '/kb/items', { name: '灰度发布流程', summary: '放量', body: '正文里有龙猫这个词' });
  expect((await call('POST', '/kb/search', { query: '灰度' })).body.items.length).toBe(1);
  expect((await call('POST', '/kb/search', { query: '龙猫' })).body.items.length).toBe(0);
});

test('索引块一行一条，带 id 便于 kb_get', async () => {
  await call('POST', '/kb/items', { name: '灰度发布流程', tag: '流程+发布', summary: '放量', body: '## 何时用\n上线新版本时' });
  const idx = await call('GET', '/kb/index');
  expect(idx.body.items.length).toBe(1);
  expect(idx.body.block).toContain('灰度发布流程');
  expect(idx.body.block).toContain('kb_get');
});

test('改标签与一句话；软删后列表看不到、单条仍能读', async () => {
  const a = await call('POST', '/kb/items', { name: '临时', body: 'x' });
  const id = a.body.item.id;

  const p = await call('PATCH', `/kb/items/${id}`, { tag: '笔记+临时', summary: '改过的一句话' });
  expect(p.body.item.tag).toBe('笔记+临时');
  expect(p.body.item.summary).toBe('改过的一句话');

  expect((await call('DELETE', `/kb/items/${id}`)).status).toBe(204);
  expect((await call('GET', '/kb/items')).body.items.length).toBe(0);
  expect((await call('GET', `/kb/items/${id}`)).body.item.status).toBe('archived');
  expect((await call('GET', '/kb/items?status=archived')).body.items.length).toBe(1);
});

test('校验：没名字 / 空正文 / 不存在的 id', async () => {
  expect((await call('POST', '/kb/items', { body: 'x' })).status).toBe(400);
  expect((await call('POST', '/kb/items', { name: 'x' })).status).toBe(400);
  expect((await call('GET', '/kb/items/kb_nope')).status).toBe(404);
  expect((await call('GET', '/kb/items/不合法')).status).toBe(400);
});

test('health schemaVersion 含知识库迁移', async () => {
  expect((await call('GET', '/health')).body.schemaVersion).toBe(8);
});
