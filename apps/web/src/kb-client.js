// ─────────────────────────────────────────────────────────────────────────────
// 知识库（AOCI）客户端：拉可注入 system 的索引短块，拉条目列表 / 单条。
// 索引是「一行一条」的清单，模型平时只看到它；要正文再 kb_get。
// ─────────────────────────────────────────────────────────────────────────────

import { authHeaders } from './accounts.js';

const TTL_MS = 20_000;
let cache = { at: 0, block: '' };

/** 拉知识库索引块；失败或知识库为空时返回空串 */
export async function loadKbIndex({ limit = 40, force = false } = {}) {
  if (!force && cache.block != null && Date.now() - cache.at < TTL_MS) return cache.block;
  try {
    const r = await fetch(`/api/kb/index?limit=${Math.max(1, Math.min(80, limit))}`, { headers: authHeaders() });
    if (!r.ok) {
      cache = { at: Date.now(), block: '' };
      return '';
    }
    const j = await r.json();
    const block = String(j.block || '').trim();
    cache = { at: Date.now(), block };
    return block;
  } catch (e) {
    cache = { at: Date.now(), block: '' };
    return '';
  }
}

/** 入库 / 删除 / 改名之后调用，下一轮立刻看到新索引 */
export function invalidateKbCache() {
  cache = { at: 0, block: '' };
}

/** 设置页用：列表（索引行 + 命中次数 + 证据条数） */
export async function listKb({ limit = 200, status = 'active' } = {}) {
  const r = await fetch(`/api/kb/items?limit=${limit}&status=${encodeURIComponent(status)}`, { headers: authHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.items || [];
}

/** 设置页用：单条（索引行 + 正文 + 证据） */
export async function getKb(id) {
  const r = await fetch(`/api/kb/items/${encodeURIComponent(id)}`, { headers: authHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function patchKb(id, patch) {
  const r = await fetch(`/api/kb/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  invalidateKbCache();
  return j.item;
}

export async function archiveKb(id) {
  const r = await fetch(`/api/kb/items/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  invalidateKbCache();
  return true;
}
