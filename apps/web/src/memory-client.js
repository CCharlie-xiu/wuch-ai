// ─────────────────────────────────────────────────────────────────────────────
// 跨会话记忆：前端取 L2 prompt 短块 + 可选 L1 会话摘要。
// ─────────────────────────────────────────────────────────────────────────────

import { authHeaders } from './accounts.js';

const TTL_MS = 30_000;
let cache = { at: 0, block: '' };

/** 拉可注入 system 的记忆短块；失败或关闭时返回空串 */
export async function loadMemoryBlock({ limit = 12, force = false } = {}) {
  if (!force && cache.block != null && Date.now() - cache.at < TTL_MS) return cache.block;
  try {
    const r = await fetch(`/api/memory/prompt-block?limit=${Math.max(1, Math.min(40, limit))}`, { headers: authHeaders() });
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

/**
 * 会话内 L1：历史较长时注入，减轻只靠最近原文的断裂感。
 * @param {string|null} conversationId
 * @param {number} historyLen messages 条数
 */
export async function loadSessionSummary(conversationId, historyLen = 0) {
  if (!conversationId || historyLen < 8) return '';
  try {
    const r = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/summary`, { headers: authHeaders() });
    if (!r.ok) return '';
    const j = await r.json();
    return String(j.summary || '').trim();
  } catch (e) {
    return '';
  }
}

/** 设置页改过记忆后调用，下一轮立刻用新内容 */
export function invalidateMemoryCache() {
  cache = { at: 0, block: '' };
}
