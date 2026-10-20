// 跨会话记忆 + Token 计量 + 会话 L1 摘要（D1 异步版，对齐 apps/server/src/memory.mjs）

import { ApiError } from './errors.js';

const SETTING_KEY = 'memory.config';
const TYPES = new Set(['fact', 'preference', 'goal', 'decision', 'constraint', 'temp']);
const HALF_LIFE = { preference: 180, constraint: 180, goal: 90, fact: 90, decision: 90, temp: 14 };
const DEFAULTS = {
  enabled: true,
  includeInProfile: true,
  confidenceThreshold: 0.5,
};
const DECAY_KEY = 'memory.lastDecayAt';
const DECAY_INTERVAL_MS = 86_400_000;
const DAY_MS = 86_400_000;
const TAG_SEP = '\0';

function storageTag(accountId, tag) {
  return `${accountId}${TAG_SEP}${tag}`;
}

function displayTag(accountId, stored) {
  const prefix = `${accountId}${TAG_SEP}`;
  return stored && stored.startsWith(prefix) ? stored.slice(prefix.length) : stored;
}

const shortId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export function fingerprint(statement) {
  return String(statement || '')
    .trim()
    .toLowerCase()
    .replace(/^(用户|我|本人)\s*/u, '')
    .replace(/[\s，。,.!！？?；;：:、]+/gu, '')
    .slice(0, 200);
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function bumpConfidence(c, delta = 0.2, cap = 0.95) {
  return Math.min(cap, clamp01(c) + (1 - clamp01(c)) * delta);
}

export function decayedConfidence(c0, lastSeen, halfLifeDays, now = Date.now()) {
  const life = Math.max(1, Number(halfLifeDays) || 90);
  const days = Math.max(0, (now - Number(lastSeen || now)) / DAY_MS);
  return clamp01(Number(c0) * Math.pow(0.5, days / life));
}

export function composeSessionSummary(turnSummaries, { maxBullets = 12, maxLen = 800 } = {}) {
  const bullets = [];
  const seen = new Set();
  for (const s of turnSummaries || []) {
    const list = Array.isArray(s) ? s : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const title = String(item.title || '').trim();
      const text = String(item.text || '').trim();
      const line = [title, text].filter(Boolean).join('：').slice(0, 120);
      if (!line || seen.has(line)) continue;
      if (/^(判断怎么回答|直接回答|需要界面|加载组件|载入界面规范|绘制界面)/.test(title)) continue;
      seen.add(line);
      bullets.push(`- ${line}`);
      if (bullets.length >= maxBullets) break;
    }
    if (bullets.length >= maxBullets) break;
  }
  if (!bullets.length) return '';
  let out = `## 本会话要点\n\n${bullets.join('\n')}`;
  if (out.length > maxLen) out = out.slice(0, maxLen - 1) + '…';
  return out;
}

const RULES = [
  { re: /(?:我(?:喜欢|更喜欢|偏好)|请(?:以后)?用|以后都用)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'preference', prefix: '偏好' },
  { re: /(?:我(?:不喜欢|讨厌|不想要)|不要(?:再)?用|别用)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'preference', prefix: '不偏好' },
  { re: /(?:我(?:叫|的名字是)|称呼我(?:为|作)?)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'fact', prefix: '称呼' },
  { re: /(?:我(?:住在|在)|所在(?:城市|地)(?:是|为)?)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'fact', prefix: '所在地' },
  { re: /(?:目标是|我想要|我打算|计划)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'goal', prefix: '目标' },
  { re: /(?:必须|一定要|千万不要|禁止)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'constraint', prefix: '约束' },
];

export function extractCandidates(userText) {
  const text = String(userText || '').trim();
  if (!text || text.length < 4) return [];
  const out = [];
  const seen = new Set();
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const raw = String(m[1] || '').trim().replace(/[。.!！？?\s]+$/u, '');
    if (raw.length < 1 || raw.length > 80) continue;
    const statement = `${rule.prefix}：${raw}`;
    const key = fingerprint(statement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: rule.type,
      statement,
      statementKey: key,
      signal: 'user_asserted',
      confidence: 0.72,
    });
  }
  return out;
}

function toItem(r) {
  return {
    id: r.id,
    type: r.type,
    statement: r.statement,
    statementKey: r.statement_key,
    confidence: r.confidence,
    evidenceCount: r.evidence_count,
    halfLife: r.half_life,
    status: r.status,
    signal: r.signal,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    supersededBy: r.superseded_by || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTag(r, accountId) {
  let sources = [];
  try {
    sources = JSON.parse(r.source_memory_ids || '[]');
  } catch {
    sources = [];
  }
  return {
    id: r.id,
    tag: accountId ? displayTag(accountId, r.tag) : r.tag,
    value: r.value,
    confidence: r.confidence,
    sourceMemoryIds: sources,
    updatedAt: r.updated_at,
  };
}

export function createMemoryRepo(db, accountId) {
  if (!db) {
    const noop = async () => null;
    return {
      settings: async () => ({ ...DEFAULTS }),
      updateSettings: async () => ({ ...DEFAULTS }),
      list: async () => [],
      get: async () => null,
      confirm: noop,
      reject: noop,
      edit: noop,
      clearProfile: async () => ({ cleared: 0 }),
      exclusions: async () => [],
      setExcluded: async () => false,
      recordMetrics: noop,
      metricsFor: async () => ({ turns: [], totals: { prompt: 0, completion: 0, total: 0 } }),
      ingestTurn: async () => ({ ingested: 0, items: [] }),
      promptBlock: async () => '',
      profile: async () => [],
      getSummary: async () => null,
      rebuildSummary: async () => null,
      decay: async () => ({ updated: 0, demoted: 0 }),
      maybeDecay: async () => ({ updated: 0, demoted: 0, skipped: true }),
    };
  }

  const configKey = accountId ? `${SETTING_KEY}:${accountId}` : SETTING_KEY;
  const decayKey = accountId ? `${DECAY_KEY}:${accountId}` : DECAY_KEY;

  async function assertConversationAccess(conversationId) {
    if (!accountId || !conversationId) return;
    const row = await db
      .prepare('SELECT user_id FROM conversation WHERE id = ? AND deleted_at IS NULL')
      .bind(conversationId)
      .first();
    if (!row || row.user_id !== accountId) throw new ApiError(404, '会话不存在');
  }

  async function loadSettings() {
    const row = await db.prepare('SELECT value FROM app_setting WHERE key = ?').bind(configKey).first();
    let saved = null;
    if (row?.value) {
      try {
        saved = JSON.parse(row.value);
      } catch {
        saved = null;
      }
    }
    const threshold = Number(saved?.confidenceThreshold);
    return {
      enabled: saved?.enabled !== false,
      includeInProfile: saved?.includeInProfile !== false,
      confidenceThreshold: Number.isFinite(threshold) ? clamp01(threshold) : DEFAULTS.confidenceThreshold,
    };
  }

  async function writeSettings(next) {
    await db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(configKey, JSON.stringify(next), Date.now())
      .run();
    return next;
  }

  async function isExcluded(conversationId) {
    await assertConversationAccess(conversationId);
    const row = await db.prepare('SELECT conversation_id FROM session_exclusion WHERE conversation_id = ?').bind(conversationId).first();
    return !!row;
  }

  async function needItem(id) {
    const row = accountId
      ? await db.prepare('SELECT * FROM memory_item WHERE id = ? AND account_id = ?').bind(id, accountId).first()
      : await db.prepare('SELECT * FROM memory_item WHERE id = ?').bind(id).first();
    if (!row) throw new ApiError(404, '这条记忆不存在');
    return row;
  }

  async function upsertCandidate(c, { conversationId, turnId }, now, threshold) {
    const key = c.statementKey || fingerprint(c.statement);
    if (!key) return null;
    const existing = accountId
      ? await db
          .prepare(
            `SELECT * FROM memory_item WHERE account_id = ? AND statement_key = ? AND status NOT IN ('rejected', 'superseded')
             ORDER BY confidence DESC LIMIT 1`,
          )
          .bind(accountId, key)
          .first()
      : await db
          .prepare(
            `SELECT * FROM memory_item WHERE statement_key = ? AND status NOT IN ('rejected', 'superseded')
             ORDER BY confidence DESC LIMIT 1`,
          )
          .bind(key)
          .first();
    if (existing && existing.status === 'rejected') return null;

    if (existing) {
      const conf = bumpConfidence(existing.confidence, c.signal === 'user_asserted' ? 0.25 : 0.15);
      const signal = c.signal === 'user_asserted' || existing.signal === 'user_asserted' ? 'user_asserted' : existing.signal;
      let status = existing.status;
      if (status === 'candidate' && conf >= threshold) status = 'active';
      if (status !== 'confirmed' && c.signal === 'user_asserted' && conf >= 0.7) status = 'active';
      await db.batch([
        db
          .prepare(
            `UPDATE memory_item SET confidence = ?, evidence_count = ?, last_seen = ?, status = ?,
                    signal = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(conf, existing.evidence_count + 1, now, status, signal, now, existing.id),
        db
          .prepare(
            `INSERT OR IGNORE INTO memory_evidence (memory_id, conversation_id, turn_id, signal, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(existing.id, conversationId, turnId || null, c.signal, now),
      ]);
      const row = await db.prepare('SELECT * FROM memory_item WHERE id = ?').bind(existing.id).first();
      return toItem(row);
    }

    const id = shortId('mem_');
    const conf = clamp01(c.confidence);
    const status = conf >= threshold ? 'active' : 'candidate';
    const type = TYPES.has(c.type) ? c.type : 'fact';
    await db.batch([
      db
        .prepare(
          `INSERT INTO memory_item
            (id, account_id, type, statement, statement_key, confidence, evidence_count, half_life, status, signal,
             first_seen, last_seen, superseded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .bind(
          id,
          accountId,
          type,
          c.statement,
          key,
          conf,
          1,
          HALF_LIFE[type] || 90,
          status,
          c.signal === 'user_asserted' ? 'user_asserted' : 'inferred',
          now,
          now,
          now,
          now,
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO memory_evidence (memory_id, conversation_id, turn_id, signal, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(id, conversationId, turnId || null, c.signal || 'inferred', now),
    ]);
    const row = await db.prepare('SELECT * FROM memory_item WHERE id = ?').bind(id).first();
    return toItem(row);
  }

  async function rebuildProfile(settings) {
    if (!settings.includeInProfile) return;
    const sql = accountId
      ? `SELECT * FROM memory_item
         WHERE account_id = ? AND status IN ('confirmed', 'active') AND confidence >= ?
         ORDER BY confidence DESC LIMIT 200`
      : `SELECT * FROM memory_item
         WHERE status IN ('confirmed', 'active') AND confidence >= ?
         ORDER BY confidence DESC LIMIT 200`;
    const { results } = accountId
      ? await db.prepare(sql).bind(accountId, settings.confidenceThreshold).all()
      : await db.prepare(sql).bind(settings.confidenceThreshold).all();
    for (const r of results || []) {
      if (r.status !== 'confirmed' && r.confidence < 0.8) continue;
      if (r.type !== 'preference' && r.type !== 'fact' && r.type !== 'constraint') continue;
      const tagStored = accountId ? storageTag(accountId, r.type) : r.type;
      await db
        .prepare(
          `INSERT INTO profile_tag (id, account_id, tag, value, confidence, source_memory_ids, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tag, value) DO UPDATE SET
             confidence = excluded.confidence,
             source_memory_ids = excluded.source_memory_ids,
             updated_at = excluded.updated_at`,
        )
        .bind(shortId('pt_'), accountId, tagStored, r.statement, r.confidence, JSON.stringify([r.id]), Date.now())
        .run();
    }
  }

  return {
    settings: loadSettings,

    async updateSettings(patch = {}) {
      const cur = await loadSettings();
      const next = {
        enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
        includeInProfile: patch.includeInProfile != null ? !!patch.includeInProfile : cur.includeInProfile,
        confidenceThreshold:
          patch.confidenceThreshold != null ? clamp01(Number(patch.confidenceThreshold)) : cur.confidenceThreshold,
      };
      return writeSettings(next);
    },

    async list({ limit = 100, includeRejected = false } = {}) {
      const n = Math.max(1, Math.min(500, Number(limit) || 100));
      let sql;
      if (accountId) {
        sql = includeRejected
          ? 'SELECT * FROM memory_item WHERE account_id = ? ORDER BY last_seen DESC LIMIT ?'
          : `SELECT * FROM memory_item
             WHERE account_id = ? AND status != 'rejected'
             ORDER BY
               CASE status WHEN 'confirmed' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
               confidence DESC, last_seen DESC
             LIMIT ?`;
      } else {
        sql = includeRejected
          ? 'SELECT * FROM memory_item ORDER BY last_seen DESC LIMIT ?'
          : `SELECT * FROM memory_item
             WHERE status != 'rejected'
             ORDER BY
               CASE status WHEN 'confirmed' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
               confidence DESC, last_seen DESC
             LIMIT ?`;
      }
      const { results } = accountId ? await db.prepare(sql).bind(accountId, n).all() : await db.prepare(sql).bind(n).all();
      return (results || []).map(toItem);
    },

    async get(id) {
      const row = accountId
        ? await db.prepare('SELECT * FROM memory_item WHERE id = ? AND account_id = ?').bind(id, accountId).first()
        : await db.prepare('SELECT * FROM memory_item WHERE id = ?').bind(id).first();
      return row ? toItem(row) : null;
    },

    async confirm(id) {
      await needItem(id);
      const now = Date.now();
      await db.prepare('UPDATE memory_item SET status = ?, confidence = ?, updated_at = ? WHERE id = ?').bind('confirmed', 1, now, id).run();
      await rebuildProfile(await loadSettings());
      const row = await db.prepare('SELECT * FROM memory_item WHERE id = ?').bind(id).first();
      return toItem(row);
    },

    async reject(id) {
      const row = await needItem(id);
      const now = Date.now();
      if (accountId) {
        await db
          .prepare(
            `UPDATE memory_item SET status = 'rejected', updated_at = ? WHERE account_id = ? AND statement_key = ? AND status != 'rejected'`,
          )
          .bind(now, accountId, row.statement_key)
          .run();
      } else {
        await db
          .prepare(`UPDATE memory_item SET status = 'rejected', updated_at = ? WHERE statement_key = ? AND status != 'rejected'`)
          .bind(now, row.statement_key)
          .run();
      }
      const updated = await db.prepare('SELECT * FROM memory_item WHERE id = ?').bind(id).first();
      return toItem(updated);
    },

    async edit(id, { statement, type } = {}) {
      const row = await needItem(id);
      const nextStatement = String(statement ?? row.statement).trim();
      if (!nextStatement) throw new ApiError(400, '记忆陈述不能为空');
      const nextType = type && TYPES.has(type) ? type : row.type;
      const key = fingerprint(nextStatement);
      await db
        .prepare('UPDATE memory_item SET statement = ?, statement_key = ?, type = ?, updated_at = ? WHERE id = ?')
        .bind(nextStatement, key, nextType, Date.now(), id)
        .run();
      const updated = await db.prepare('SELECT * FROM memory_item WHERE id = ?').bind(id).first();
      return toItem(updated);
    },

    async clearProfile() {
      const r = accountId
        ? await db.prepare('DELETE FROM profile_tag WHERE account_id = ?').bind(accountId).run()
        : await db.prepare('DELETE FROM profile_tag').run();
      return { cleared: r.meta.changes ?? 0 };
    },

    async profile() {
      const { results } = accountId
        ? await db.prepare('SELECT * FROM profile_tag WHERE account_id = ? ORDER BY confidence DESC, tag').bind(accountId).all()
        : await db.prepare('SELECT * FROM profile_tag ORDER BY confidence DESC, tag').all();
      return (results || []).map((r) => toTag(r, accountId));
    },

    async exclusions() {
      const sql = accountId
        ? `SELECT se.conversation_id, se.excluded_at FROM session_exclusion se
           JOIN conversation c ON c.id = se.conversation_id
           WHERE c.user_id = ?
           ORDER BY se.excluded_at DESC`
        : 'SELECT conversation_id, excluded_at FROM session_exclusion ORDER BY excluded_at DESC';
      const { results } = accountId ? await db.prepare(sql).bind(accountId).all() : await db.prepare(sql).all();
      return (results || []).map((r) => ({ conversationId: r.conversation_id, excludedAt: r.excluded_at }));
    },

    async setExcluded(conversationId, excluded) {
      if (typeof conversationId !== 'string' || !conversationId) throw new ApiError(400, 'conversationId 无效');
      await assertConversationAccess(conversationId);
      if (excluded) {
        await db
          .prepare(
            `INSERT INTO session_exclusion (conversation_id, excluded_at) VALUES (?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET excluded_at = excluded.excluded_at`,
          )
          .bind(conversationId, Date.now())
          .run();
        const { results } = await db
          .prepare('SELECT memory_id FROM memory_evidence WHERE conversation_id = ?')
          .bind(conversationId)
          .all();
        const memIds = (results || []).map((r) => r.memory_id);
        await db.prepare('DELETE FROM memory_evidence WHERE conversation_id = ?').bind(conversationId).run();
        const now = Date.now();
        const stmts = [];
        for (const mid of memIds) {
          const cnt = await db.prepare('SELECT COUNT(*) AS n FROM memory_evidence WHERE memory_id = ?').bind(mid).first();
          const n = cnt?.n ?? 0;
          stmts.push(db.prepare('UPDATE memory_item SET evidence_count = ?, updated_at = ? WHERE id = ?').bind(n, now, mid));
          if (n <= 0) {
            stmts.push(
              db.prepare(`DELETE FROM memory_item WHERE id = ? AND evidence_count <= 0 AND status NOT IN ('confirmed')`).bind(mid),
            );
          }
        }
        if (stmts.length) await db.batch(stmts);
        return true;
      }
      await db.prepare('DELETE FROM session_exclusion WHERE conversation_id = ?').bind(conversationId).run();
      return true;
    },

    async recordMetrics(conversationId, turnId, metrics = {}) {
      if (!conversationId) return null;
      await assertConversationAccess(conversationId);
      const prompt = Math.max(0, Math.floor(Number(metrics.promptTokens) || 0));
      const completion = Math.max(0, Math.floor(Number(metrics.completionTokens) || 0));
      const total = Math.max(0, Math.floor(Number(metrics.totalTokens) || prompt + completion));
      const usage = metrics.contextUsage != null ? Number(metrics.contextUsage) : null;
      const cacheHit = metrics.cacheHitTokens == null ? null : Math.max(0, Math.floor(Number(metrics.cacheHitTokens) || 0));
      const cacheMiss = metrics.cacheMissTokens == null ? null : Math.max(0, Math.floor(Number(metrics.cacheMissTokens) || 0));
      await db
        .prepare(
          `INSERT INTO session_metrics
            (conversation_id, turn_id, prompt_tokens, completion_tokens, total_tokens, context_usage,
             cache_hit_tokens, cache_miss_tokens, estimated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          conversationId,
          turnId || null,
          prompt,
          completion,
          total,
          Number.isFinite(usage) ? usage : null,
          cacheHit,
          cacheMiss,
          metrics.estimated ? 1 : 0,
          Date.now(),
        )
        .run();
      return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
    },

    async metricsFor(conversationId) {
      await assertConversationAccess(conversationId);
      const { results } = await db
        .prepare('SELECT * FROM session_metrics WHERE conversation_id = ? ORDER BY created_at, id')
        .bind(conversationId)
        .all();
      const turns = (results || []).map((r) => ({
        turnId: r.turn_id,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        totalTokens: r.total_tokens,
        contextUsage: r.context_usage,
        cacheHitTokens: r.cache_hit_tokens,
        cacheMissTokens: r.cache_miss_tokens,
        estimated: !!r.estimated,
        createdAt: r.created_at,
      }));
      const sum = await db
        .prepare(
          `SELECT COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion,
                  COALESCE(SUM(total_tokens),0) AS total,
                  COALESCE(SUM(cache_hit_tokens),0) AS cache_hit,
                  COALESCE(SUM(cache_miss_tokens),0) AS cache_miss,
                  SUM(CASE WHEN cache_hit_tokens IS NULL AND cache_miss_tokens IS NULL THEN 0 ELSE 1 END) AS cache_reported
           FROM session_metrics WHERE conversation_id = ?`,
        )
        .bind(conversationId)
        .first();
      return {
        turns,
        totals: {
          prompt: sum?.prompt ?? 0,
          completion: sum?.completion ?? 0,
          total: sum?.total ?? 0,
          cacheHit: sum?.cache_hit ?? 0,
          cacheMiss: sum?.cache_miss ?? 0,
          cacheReported: sum?.cache_reported ?? 0,
        },
      };
    },

    async ingestTurn({ conversationId, turnId, userText }) {
      const settings = await loadSettings();
      if (!settings.enabled) return { ingested: 0, items: [], skipped: 'disabled' };
      if (!conversationId) return { ingested: 0, items: [], skipped: 'no_conversation' };
      if (await isExcluded(conversationId)) return { ingested: 0, items: [], skipped: 'excluded' };

      const candidates = extractCandidates(userText);
      const now = Date.now();
      const items = [];
      for (const c of candidates) {
        const item = await upsertCandidate(c, { conversationId, turnId }, now, settings.confidenceThreshold);
        if (item) items.push(item);
      }
      if (items.length) await rebuildProfile(settings);
      const summary = await this.rebuildSummary(conversationId);
      return { ingested: items.length, items, summary: summary?.summary || '' };
    },

    async getSummary(conversationId) {
      if (!conversationId) return null;
      await assertConversationAccess(conversationId);
      const row = await db.prepare('SELECT conversation_id, summary, updated_at FROM session_summary WHERE conversation_id = ?').bind(conversationId).first();
      return row ? { conversationId: row.conversation_id, summary: row.summary, updatedAt: row.updated_at } : null;
    },

    async rebuildSummary(conversationId) {
      await assertConversationAccess(conversationId);
      const live = await db.prepare('SELECT id FROM conversation WHERE id = ? AND deleted_at IS NULL').bind(conversationId).first();
      if (!live) return null;
      if (await isExcluded(conversationId)) {
        await db.prepare('DELETE FROM session_summary WHERE conversation_id = ?').bind(conversationId).run();
        return { conversationId, summary: '', updatedAt: Date.now() };
      }
      const { results } = await db
        .prepare(
          `SELECT summary FROM turn WHERE conversation_id = ? AND state = 'complete'
           ORDER BY seq DESC LIMIT 16`,
        )
        .bind(conversationId)
        .all();
      const parsed = (results || []).map((r) => {
        try {
          return JSON.parse(r.summary || '[]');
        } catch {
          return [];
        }
      });
      const text = composeSessionSummary(parsed);
      const now = Date.now();
      if (!text) {
        await db.prepare('DELETE FROM session_summary WHERE conversation_id = ?').bind(conversationId).run();
        return { conversationId, summary: '', updatedAt: now };
      }
      await db
        .prepare(
          `INSERT INTO session_summary (conversation_id, summary, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
        )
        .bind(conversationId, text, now)
        .run();
      return { conversationId, summary: text, updatedAt: now };
    },

    async decay({ now = Date.now(), threshold } = {}) {
      const settings = await loadSettings();
      const gate = threshold != null ? clamp01(Number(threshold)) : settings.confidenceThreshold;
      let updated = 0;
      let demoted = 0;
      const { results } = accountId
        ? await db
            .prepare(
              `SELECT id, confidence, last_seen, half_life, status FROM memory_item
               WHERE account_id = ? AND status IN ('candidate', 'active', 'confirmed')`,
            )
            .bind(accountId)
            .all()
        : await db
            .prepare(`SELECT id, confidence, last_seen, half_life, status FROM memory_item WHERE status IN ('candidate', 'active', 'confirmed')`)
            .all();
      const stmts = [];
      for (const r of results || []) {
        const next = decayedConfidence(r.confidence, r.last_seen, r.half_life, now);
        if (Math.abs(next - r.confidence) < 0.001) continue;
        let status = r.status;
        if (status === 'confirmed' && next < gate) {
          status = 'active';
          demoted++;
        } else if (status === 'active' && next < gate * 0.5) {
          status = 'candidate';
          demoted++;
        }
        stmts.push(db.prepare('UPDATE memory_item SET confidence = ?, status = ?, updated_at = ? WHERE id = ?').bind(next, status, now, r.id));
        updated++;
      }
      stmts.push(
        db
          .prepare(
            `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(decayKey, String(now), now),
      );
      if (stmts.length) await db.batch(stmts);
      return { updated, demoted, at: now };
    },

    async maybeDecay() {
      const row = await db.prepare('SELECT value FROM app_setting WHERE key = ?').bind(decayKey).first();
      const last = row?.value ? Number(row.value) : 0;
      if (Number.isFinite(last) && Date.now() - last < DECAY_INTERVAL_MS) {
        return { updated: 0, demoted: 0, skipped: true, lastAt: last || null };
      }
      return this.decay();
    },

    async promptBlock({ limit = 12 } = {}) {
      await this.maybeDecay();
      const settings = await loadSettings();
      if (!settings.enabled) return '';
      const n = Math.max(1, Math.min(40, Number(limit) || 12));
      const { results } = accountId
        ? await db
            .prepare(
              `SELECT * FROM memory_item
               WHERE account_id = ? AND status != 'rejected'
               ORDER BY
                 CASE status WHEN 'confirmed' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
                 confidence DESC, last_seen DESC
               LIMIT ?`,
            )
            .bind(accountId, n)
            .all()
        : await db
            .prepare(
              `SELECT * FROM memory_item
               WHERE status != 'rejected'
               ORDER BY
                 CASE status WHEN 'confirmed' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
                 confidence DESC, last_seen DESC
               LIMIT ?`,
            )
            .bind(n)
            .all();
      const rows = (results || []).filter(
        (r) => r.status === 'confirmed' || (r.status === 'active' && r.confidence >= settings.confidenceThreshold),
      );
      if (!rows.length) return '';
      const lines = rows.slice(0, n).map((r) => `- (${r.type}) ${r.statement}`);
      return `## 关于用户的已知信息（来自跨会话记忆，可能过时；与用户本轮话冲突时以本轮为准）\n\n${lines.join('\n')}`;
    },
  };
}

export async function handleMemory(request, db, path, url, account) {
  const method = request.method;
  const memory = createMemoryRepo(db, account.id);
  const bodyJson = async () => {
    try {
      return await request.json();
    } catch {
      throw new ApiError(400, '请求体不是合法 JSON');
    }
  };

  if (method === 'GET' && path === '/memory/settings') return { status: 200, body: await memory.settings() };
  if (method === 'PUT' && path === '/memory/settings') return { status: 200, body: await memory.updateSettings(await bodyJson()) };

  if (method === 'GET' && path === '/memory/items') {
    return { status: 200, body: { items: await memory.list({ limit: url.searchParams.get('limit') }) } };
  }

  let m = /^\/memory\/items\/([^/]+)\/confirm$/.exec(path);
  if (method === 'POST' && m) return { status: 200, body: { item: await memory.confirm(decodeURIComponent(m[1])) } };

  m = /^\/memory\/items\/([^/]+)\/reject$/.exec(path);
  if (method === 'POST' && m) return { status: 200, body: { item: await memory.reject(decodeURIComponent(m[1])) } };

  m = /^\/memory\/items\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && m) return { status: 200, body: { item: await memory.edit(decodeURIComponent(m[1]), await bodyJson()) } };

  if (method === 'GET' && path === '/memory/profile') return { status: 200, body: { tags: await memory.profile() } };
  if (method === 'DELETE' && path === '/memory/profile') return { status: 200, body: await memory.clearProfile() };

  if (method === 'GET' && path === '/memory/exclusions') return { status: 200, body: { exclusions: await memory.exclusions() } };

  m = /^\/memory\/exclusions\/([^/]+)$/.exec(path);
  if (method === 'PUT' && m) {
    const { excluded } = await bodyJson();
    await memory.setExcluded(decodeURIComponent(m[1]), excluded !== false);
    return { status: 200, body: { exclusions: await memory.exclusions() } };
  }

  if (method === 'GET' && path === '/memory/prompt-block') {
    return { status: 200, body: { block: await memory.promptBlock({ limit: url.searchParams.get('limit') }) } };
  }

  if (method === 'POST' && path === '/memory/decay') return { status: 200, body: await memory.decay() };

  throw new ApiError(404, '没有这个接口');
}
