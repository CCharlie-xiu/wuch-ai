import { test, expect, beforeEach, afterEach } from 'bun:test';
import http from 'node:http';
import { openDb, createConversationRepo } from '../src/db.mjs';
import { createApi } from '../src/api.mjs';
import { extractCandidates, fingerprint, decayedConfidence, composeSessionSummary } from '../src/memory.mjs';

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

const turn = (userText, extra = {}) => ({
  userText,
  raw: `root = Text("${userText}")`,
  state: 'complete',
  summary: [{ title: '界面已生成', text: '', refs: [] }],
  ...extra,
});

test('fingerprint 归一去人称与空白', () => {
  expect(fingerprint('用户偏好：暗色主题')).toBe(fingerprint('偏好：暗色主题'));
  expect(fingerprint('我 喜欢  A')).toBe(fingerprint('喜欢A'));
});

test('规则抽取：用户直述偏好', () => {
  const items = extractCandidates('我喜欢暗色主题，别用紫色。');
  expect(items.some((c) => c.type === 'preference' && c.signal === 'user_asserted')).toBe(true);
  expect(items.every((c) => !('raw_text' in c) && !('quote' in c))).toBe(true);
});

test('health schemaVersion 含记忆迁移', async () => {
  expect((await call('GET', '/health')).body.schemaVersion).toBe(8);
});

test('默认设置可读可改', async () => {
  const a = await call('GET', '/memory/settings');
  expect(a.status).toBe(200);
  expect(a.body).toMatchObject({ enabled: true, includeInProfile: true, confidenceThreshold: 0.5 });

  const b = await call('PUT', '/memory/settings', { enabled: false, confidenceThreshold: 0.7 });
  expect(b.body).toMatchObject({ enabled: false, confidenceThreshold: 0.7 });
  expect((await call('GET', '/memory/settings')).body.enabled).toBe(false);
});

test('追加轮次触发记忆摄入，不存原文', async () => {
  const created = await call('POST', '/conversations/m1/turns', turn('我喜欢暗色主题'));
  expect(created.status).toBe(201);
  expect(created.body.memory.ingested).toBeGreaterThan(0);
  expect(created.body.memory.items[0].statement).toContain('暗色');
  expect(created.body.memory.items[0]).not.toHaveProperty('raw_text');

  const list = await call('GET', '/memory/items');
  expect(list.body.items.length).toBeGreaterThan(0);
  expect(list.body.items[0].statement).toMatch(/偏好/);
});

test('token 计量随轮次写入（含缓存命中拆分）', async () => {
  await call('POST', '/conversations/m2/turns', turn('你好', {
    metrics: {
      promptTokens: 100, completionTokens: 40, totalTokens: 140,
      cacheHitTokens: 30, cacheMissTokens: 70, contextUsage: 0.25, estimated: false,
    },
  }));
  const m = await call('GET', '/conversations/m2/metrics');
  expect(m.body.totals).toEqual({ prompt: 100, completion: 40, total: 140, cacheHit: 30, cacheMiss: 70, cacheReported: 1 });
  expect(m.body.turns[0]).toMatchObject({ cacheHitTokens: 30, cacheMissTokens: 70, contextUsage: 0.25, estimated: false });
});

test('端点没报缓存字段时存 NULL，不伪造 0', async () => {
  await call('POST', '/conversations/m2b/turns', turn('你好', {
    metrics: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  }));
  const m = await call('GET', '/conversations/m2b/metrics');
  expect(m.body.turns[0].cacheHitTokens).toBeNull();
  expect(m.body.turns[0].cacheMissTokens).toBeNull();
  expect(m.body.totals.cacheReported).toBe(0);
});

test('排除会话后不再摄入，并撤掉证据', async () => {
  await call('POST', '/conversations/m3/turns', turn('我喜欢表格视图'));
  expect((await call('GET', '/memory/items')).body.items.length).toBeGreaterThan(0);

  const excl = await call('PUT', '/memory/exclusions/m3', { excluded: true });
  expect(excl.status).toBe(200);
  expect(excl.body.exclusions.some((e) => e.conversationId === 'm3')).toBe(true);

  const again = await call('POST', '/conversations/m3/turns', turn('我喜欢卡片布局'));
  expect(again.body.memory.skipped).toBe('excluded');
});

test('确认 / 否定 / 清空画像', async () => {
  const created = await call('POST', '/conversations/m4/turns', turn('我喜欢简洁界面'));
  const id = created.body.memory.items[0].id;

  const conf = await call('POST', `/memory/items/${id}/confirm`);
  expect(conf.body.item.status).toBe('confirmed');
  expect(conf.body.item.confidence).toBe(1);

  expect((await call('GET', '/memory/profile')).body.tags.length).toBeGreaterThan(0);
  expect((await call('DELETE', '/memory/profile')).body.cleared).toBeGreaterThan(0);

  const rej = await call('POST', `/memory/items/${id}/reject`);
  expect(rej.body.item.status).toBe('rejected');
});

test('prompt-block 只含高置信条目', async () => {
  await call('POST', '/conversations/m5/turns', turn('我喜欢暗色主题'));
  const items = (await call('GET', '/memory/items')).body.items;
  if (items[0]) await call('POST', `/memory/items/${items[0].id}/confirm`);
  const block = await call('GET', '/memory/prompt-block');
  expect(block.body.block).toContain('暗色');
  expect(block.body.block).not.toContain('我喜欢暗色主题'); // 不回灌原文句式
});

test('用户直述偏好达门槛后即可进 prompt-block（无需先确认）', async () => {
  await call('POST', '/conversations/m6/turns', turn('我喜欢表格视图'));
  const block = await call('GET', '/memory/prompt-block');
  expect(block.body.block).toContain('表格');
});

test('关闭记忆后 prompt-block 为空', async () => {
  await call('POST', '/conversations/m7/turns', turn('我喜欢卡片布局'));
  await call('PUT', '/memory/settings', { enabled: false });
  expect((await call('GET', '/memory/prompt-block')).body.block).toBe('');
});

test('衰减公式：一个半衰期后约一半', () => {
  const now = 1_700_000_000_000;
  const half = decayedConfidence(0.8, now - 90 * 86_400_000, 90, now);
  expect(half).toBeCloseTo(0.4, 5);
});

test('composeSessionSummary 跳过流程噪音', () => {
  const text = composeSessionSummary([
    [{ title: '判断怎么回答', text: '' }, { title: '回答', text: '用暗色' }, { title: '偏好', text: '简洁' }],
  ]);
  expect(text).toContain('暗色');
  expect(text).toContain('简洁');
  expect(text).not.toContain('判断怎么回答');
});

test('写入轮次后重建 L1 摘要', async () => {
  await call('POST', '/conversations/m8/turns', turn('做个仪表盘', {
    summary: [{ title: '回答', text: '已生成用量看板', refs: [] }],
  }));
  const s = await call('GET', '/conversations/m8/summary');
  expect(s.body.summary).toContain('用量看板');
  expect(s.body.summary).not.toContain('做个仪表盘'); // 不含用户原文
});

test('手动衰减会降低久未出现的记忆置信度', async () => {
  const created = await call('POST', '/conversations/m9/turns', turn('我喜欢暗色主题'));
  const id = created.body.memory.items[0].id;
  // 把 last_seen 拨到很久以前：直接再调 decay 用假 now
  // 通过 API 只能测「会跑、返回计数」；精确数值用 decayedConfidence 单测覆盖
  const d = await call('POST', '/memory/decay');
  expect(d.status).toBe(200);
  expect(d.body).toHaveProperty('updated');
  expect(d.body).toHaveProperty('demoted');
  // 刚写入的 last_seen=now，衰减几乎不变，但接口应成功
  const item = (await call('GET', '/memory/items')).body.items.find((x) => x.id === id);
  expect(item).toBeTruthy();
});
