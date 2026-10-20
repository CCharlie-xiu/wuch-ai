// ─────────────────────────────────────────────────────────────────────────────
// 跨会话记忆：设置 + L2 原子条目 + Token 计量 + 会话排除。
//
// 硬约束：不存原文。证据只有 conversation_id / turn_id 指针。
// P2 起步用规则抽用户直述偏好；LLM 抽取后续再接。
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { RepoError } from './db.mjs';

const SETTING_KEY = 'memory.config';
const TYPES = new Set(['fact', 'preference', 'goal', 'decision', 'constraint', 'temp']);
const STATUSES = new Set(['candidate', 'active', 'confirmed', 'rejected', 'superseded']);
const HALF_LIFE = { preference: 180, constraint: 180, goal: 90, fact: 90, decision: 90, temp: 14 };
const DEFAULTS = {
  enabled: true,
  includeInProfile: true,
  confidenceThreshold: 0.5,
};

const shortId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 归一指纹：去空白 / 小写 / 去常见人称前缀，供精确去重 */
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

const DAY_MS = 86_400_000;
const DECAY_KEY = 'memory.lastDecayAt';
const DECAY_INTERVAL_MS = DAY_MS; // 每日最多自动衰减一次

/** 按半衰期衰减：c_t = c_0 × 0.5^(Δt / half_life) */
export function decayedConfidence(c0, lastSeen, halfLifeDays, now = Date.now()) {
  const life = Math.max(1, Number(halfLifeDays) || 90);
  const days = Math.max(0, (now - Number(lastSeen || now)) / DAY_MS);
  return clamp01(Number(c0) * Math.pow(0.5, days / life));
}

/** 从 turn.summary 拼 L1 要点（不写用户原文） */
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
      // 跳过纯流程步骤噪音
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

// ── 规则抽取（用户直述）────────────────────────────────────────────────────
// 命中即 user_asserted；够用做骨架，复杂事实留给后续 LLM。

const RULES = [
  { re: /(?:我(?:喜欢|更喜欢|偏好)|请(?:以后)?用|以后都用)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'preference', prefix: '偏好' },
  { re: /(?:我(?:不喜欢|讨厌|不想要)|不要(?:再)?用|别用)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'preference', prefix: '不偏好' },
  { re: /(?:我(?:叫|的名字是)|称呼我(?:为|作)?)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'fact', prefix: '称呼' },
  { re: /(?:我(?:住在|在)|所在(?:城市|地)(?:是|为)?)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'fact', prefix: '所在地' },
  { re: /(?:目标是|我想要|我打算|计划)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'goal', prefix: '目标' },
  { re: /(?:必须|一定要|千万不要|禁止)\s*(.+?)(?:[。.!！？?\n]|$)/u, type: 'constraint', prefix: '约束' },
];

/** 从一轮用户话里抽候选；不读助手原文进记忆层 */
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

function toTag(r) {
  let sources = [];
  try {
    sources = JSON.parse(r.source_memory_ids || '[]');
  } catch (e) {
    sources = [];
  }
  return {
    id: r.id,
    tag: r.tag,
    value: r.value,
    confidence: r.confidence,
    sourceMemoryIds: sources,
    updatedAt: r.updated_at,
  };
}

export function createMemoryRepo(db) {
  if (!db) {
    return {
      settings: () => ({ ...DEFAULTS }),
      updateSettings: () => ({ ...DEFAULTS }),
      list: () => [],
      get: () => null,
      confirm: () => null,
      reject: () => null,
      edit: () => null,
      clearProfile: () => ({ cleared: 0 }),
      exclusions: () => [],
      setExcluded: () => false,
      recordMetrics: () => null,
      metricsFor: () => ({ turns: [], totals: { prompt: 0, completion: 0, total: 0 } }),
      ingestTurn: () => ({ ingested: 0, items: [] }),
      promptBlock: () => '',
      profile: () => [],
      getSummary: () => null,
      rebuildSummary: () => null,
      decay: () => ({ updated: 0, demoted: 0 }),
      maybeDecay: () => ({ updated: 0, demoted: 0, skipped: true }),
    };
  }

  const q = {
    getSetting: db.prepare('SELECT value FROM app_setting WHERE key = ?'),
    putSetting: db.prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ),
    list: db.prepare(
      `SELECT * FROM memory_item
       WHERE status != 'rejected'
       ORDER BY
         CASE status WHEN 'confirmed' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,
         confidence DESC, last_seen DESC
       LIMIT ?`,
    ),
    listAll: db.prepare('SELECT * FROM memory_item ORDER BY last_seen DESC LIMIT ?'),
    get: db.prepare('SELECT * FROM memory_item WHERE id = ?'),
    byKey: db.prepare(
      `SELECT * FROM memory_item WHERE statement_key = ? AND status NOT IN ('rejected', 'superseded')
       ORDER BY confidence DESC LIMIT 1`,
    ),
    insert: db.prepare(
      `INSERT INTO memory_item
        (id, type, statement, statement_key, confidence, evidence_count, half_life, status, signal,
         first_seen, last_seen, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ),
    updateMerge: db.prepare(
      `UPDATE memory_item SET confidence = ?, evidence_count = ?, last_seen = ?, status = ?,
              signal = ?, updated_at = ? WHERE id = ?`,
    ),
    updateStatus: db.prepare('UPDATE memory_item SET status = ?, confidence = ?, updated_at = ? WHERE id = ?'),
    updateEdit: db.prepare(
      `UPDATE memory_item SET statement = ?, statement_key = ?, type = ?, updated_at = ? WHERE id = ?`,
    ),
    rejectKey: db.prepare(
      `UPDATE memory_item SET status = 'rejected', updated_at = ?
       WHERE statement_key = ? AND status != 'rejected'`,
    ),
    insertEvidence: db.prepare(
      `INSERT OR IGNORE INTO memory_evidence (memory_id, conversation_id, turn_id, signal, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    evidenceByConv: db.prepare('SELECT memory_id FROM memory_evidence WHERE conversation_id = ?'),
    deleteEvidenceConv: db.prepare('DELETE FROM memory_evidence WHERE conversation_id = ?'),
    recount: db.prepare('SELECT COUNT(*) AS n FROM memory_evidence WHERE memory_id = ?'),
    setEvidenceCount: db.prepare('UPDATE memory_item SET evidence_count = ?, updated_at = ? WHERE id = ?'),
    deleteOrphan: db.prepare(
      `DELETE FROM memory_item WHERE id = ? AND evidence_count <= 0 AND status NOT IN ('confirmed')`,
    ),
    insertMetrics: db.prepare(
      `INSERT INTO session_metrics
        (conversation_id, turn_id, prompt_tokens, completion_tokens, total_tokens, context_usage,
         cache_hit_tokens, cache_miss_tokens, estimated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    metrics: db.prepare(
      `SELECT * FROM session_metrics WHERE conversation_id = ? ORDER BY created_at, id`,
    ),
    metricsSum: db.prepare(
      `SELECT COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion,
              COALESCE(SUM(total_tokens),0) AS total,
              COALESCE(SUM(cache_hit_tokens),0) AS cache_hit,
              COALESCE(SUM(cache_miss_tokens),0) AS cache_miss,
              SUM(CASE WHEN cache_hit_tokens IS NULL AND cache_miss_tokens IS NULL THEN 0 ELSE 1 END) AS cache_reported
       FROM session_metrics WHERE conversation_id = ?`,
    ),
    exclList: db.prepare('SELECT conversation_id, excluded_at FROM session_exclusion ORDER BY excluded_at DESC'),
    exclGet: db.prepare('SELECT conversation_id FROM session_exclusion WHERE conversation_id = ?'),
    exclAdd: db.prepare(
      `INSERT INTO session_exclusion (conversation_id, excluded_at) VALUES (?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET excluded_at = excluded.excluded_at`,
    ),
    exclRemove: db.prepare('DELETE FROM session_exclusion WHERE conversation_id = ?'),
    convLive: db.prepare('SELECT id FROM conversation WHERE id = ? AND deleted_at IS NULL'),
    profileList: db.prepare('SELECT * FROM profile_tag ORDER BY confidence DESC, tag'),
    profileClear: db.prepare('DELETE FROM profile_tag'),
    profileUpsert: db.prepare(
      `INSERT INTO profile_tag (id, tag, value, confidence, source_memory_ids, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tag, value) DO UPDATE SET
         confidence = excluded.confidence,
         source_memory_ids = excluded.source_memory_ids,
         updated_at = excluded.updated_at`,
    ),
    activeForProfile: db.prepare(
      `SELECT * FROM memory_item
       WHERE status IN ('confirmed', 'active') AND confidence >= ?
       ORDER BY confidence DESC LIMIT 200`,
    ),
    turnSummaries: db.prepare(
      `SELECT summary FROM turn WHERE conversation_id = ? AND state = 'complete'
       ORDER BY seq DESC LIMIT 16`,
    ),
    getSummary: db.prepare('SELECT conversation_id, summary, updated_at FROM session_summary WHERE conversation_id = ?'),
    putSummary: db.prepare(
      `INSERT INTO session_summary (conversation_id, summary, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
    ),
    deleteSummary: db.prepare('DELETE FROM session_summary WHERE conversation_id = ?'),
    decayTargets: db.prepare(
      `SELECT id, confidence, last_seen, half_life, status FROM memory_item
       WHERE status IN ('candidate', 'active', 'confirmed')`,
    ),
    updateDecay: db.prepare('UPDATE memory_item SET confidence = ?, status = ?, updated_at = ? WHERE id = ?'),
  };

  function loadSettings() {
    const row = q.getSetting.get(SETTING_KEY);
    let saved = null;
    if (row && row.value) {
      try {
        saved = JSON.parse(row.value);
      } catch (e) {
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

  function writeSettings(next) {
    q.putSetting.run(SETTING_KEY, JSON.stringify(next), Date.now());
    return next;
  }

  function isExcluded(conversationId) {
    return !!q.exclGet.get(conversationId);
  }

  function needItem(id) {
    const row = q.get.get(id);
    if (!row) throw new RepoError(404, '这条记忆不存在');
    return row;
  }

  /** 把一条候选合并进 L2（去重累加证据） */
  function upsertCandidate(c, { conversationId, turnId }, now, threshold) {
    const key = c.statementKey || fingerprint(c.statement);
    if (!key) return null;
    const existing = q.byKey.get(key);
    if (existing && existing.status === 'rejected') return null;

    if (existing) {
      const conf = bumpConfidence(existing.confidence, c.signal === 'user_asserted' ? 0.25 : 0.15);
      const signal = c.signal === 'user_asserted' || existing.signal === 'user_asserted' ? 'user_asserted' : existing.signal;
      let status = existing.status;
      if (status === 'candidate' && conf >= threshold) status = 'active';
      if (status === 'confirmed') {
        /* 保持 */
      } else if (c.signal === 'user_asserted' && conf >= 0.7) {
        status = 'active';
      }
      q.updateMerge.run(conf, existing.evidence_count + 1, now, status, signal, now, existing.id);
      q.insertEvidence.run(existing.id, conversationId, turnId || null, c.signal, now);
      return toItem(q.get.get(existing.id));
    }

    const id = shortId('mem_');
    const conf = clamp01(c.confidence);
    const status = c.signal === 'user_asserted' && conf >= threshold ? 'active' : conf >= threshold ? 'active' : 'candidate';
    const type = TYPES.has(c.type) ? c.type : 'fact';
    q.insert.run(
      id,
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
    );
    q.insertEvidence.run(id, conversationId, turnId || null, c.signal || 'inferred', now);
    return toItem(q.get.get(id));
  }

  /** 从 active/confirmed 偏好类条目刷一层简单画像标签 */
  function rebuildProfile(settings) {
    if (!settings.includeInProfile) return;
    const rows = q.activeForProfile.all(settings.confidenceThreshold);
    for (const r of rows) {
      if (r.status !== 'confirmed' && r.confidence < 0.8) continue;
      if (r.type !== 'preference' && r.type !== 'fact' && r.type !== 'constraint') continue;
      const tag = r.type;
      const value = r.statement;
      q.profileUpsert.run(shortId('pt_'), tag, value, r.confidence, JSON.stringify([r.id]), Date.now());
    }
  }

  return {
    settings: loadSettings,

    updateSettings(patch = {}) {
      const cur = loadSettings();
      const next = {
        enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
        includeInProfile: patch.includeInProfile != null ? !!patch.includeInProfile : cur.includeInProfile,
        confidenceThreshold:
          patch.confidenceThreshold != null ? clamp01(Number(patch.confidenceThreshold)) : cur.confidenceThreshold,
      };
      return writeSettings(next);
    },

    list({ limit = 100, includeRejected = false } = {}) {
      const n = Math.max(1, Math.min(500, Number(limit) || 100));
      return (includeRejected ? q.listAll : q.list).all(n).map(toItem);
    },

    get(id) {
      const row = q.get.get(id);
      return row ? toItem(row) : null;
    },

    confirm(id) {
      needItem(id);
      const now = Date.now();
      q.updateStatus.run('confirmed', 1, now, id);
      rebuildProfile(loadSettings());
      return toItem(q.get.get(id));
    },

    reject(id) {
      const row = needItem(id);
      const now = Date.now();
      q.rejectKey.run(now, row.statement_key);
      return toItem(q.get.get(id));
    },

    edit(id, { statement, type } = {}) {
      const row = needItem(id);
      const nextStatement = String(statement ?? row.statement).trim();
      if (!nextStatement) throw new RepoError(400, '记忆陈述不能为空');
      const nextType = type && TYPES.has(type) ? type : row.type;
      const key = fingerprint(nextStatement);
      q.updateEdit.run(nextStatement, key, nextType, Date.now(), id);
      return toItem(q.get.get(id));
    },

    clearProfile() {
      const n = q.profileClear.run().changes;
      return { cleared: n };
    },

    profile() {
      return q.profileList.all().map(toTag);
    },

    exclusions() {
      return q.exclList.all().map((r) => ({ conversationId: r.conversation_id, excludedAt: r.excluded_at }));
    },

    setExcluded(conversationId, excluded) {
      if (typeof conversationId !== 'string' || !conversationId) throw new RepoError(400, 'conversationId 无效');
      if (!q.convLive.get(conversationId)) throw new RepoError(404, '会话不存在');
      if (excluded) {
        q.exclAdd.run(conversationId, Date.now());
        // 已入画像的会话被排除：删掉该会话的证据贡献；条目若无其它来源则删
        return tx(db, () => {
          const memIds = q.evidenceByConv.all(conversationId).map((r) => r.memory_id);
          q.deleteEvidenceConv.run(conversationId);
          const now = Date.now();
          for (const mid of memIds) {
            const n = q.recount.get(mid).n;
            q.setEvidenceCount.run(n, now, mid);
            if (n <= 0) q.deleteOrphan.run(mid);
          }
          return true;
        });
      }
      q.exclRemove.run(conversationId);
      return true;
    },

    recordMetrics(conversationId, turnId, metrics = {}) {
      if (!conversationId) return null;
      const prompt = Math.max(0, Math.floor(Number(metrics.promptTokens) || 0));
      const completion = Math.max(0, Math.floor(Number(metrics.completionTokens) || 0));
      const total = Math.max(0, Math.floor(Number(metrics.totalTokens) || prompt + completion));
      const usage = metrics.contextUsage != null ? Number(metrics.contextUsage) : null;
      // 缓存字段没报就是 NULL：0 会被当成「一条都没命中」，把命中率算歪
      const cacheHit = metrics.cacheHitTokens == null ? null : Math.max(0, Math.floor(Number(metrics.cacheHitTokens) || 0));
      const cacheMiss = metrics.cacheMissTokens == null ? null : Math.max(0, Math.floor(Number(metrics.cacheMissTokens) || 0));
      q.insertMetrics.run(
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
      );
      return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
    },

    metricsFor(conversationId) {
      const turns = q.metrics.all(conversationId).map((r) => ({
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
      const sum = q.metricsSum.get(conversationId);
      return {
        turns,
        totals: {
          prompt: sum.prompt,
          completion: sum.completion,
          total: sum.total,
          cacheHit: sum.cache_hit,
          cacheMiss: sum.cache_miss,
          cacheReported: sum.cache_reported,
        },
      };
    },

    /**
     * 一轮结束后的摄入：排除 / 关闭记忆则跳过。
     * 只从 userText 抽规则候选（硬约束：不把原文写进记忆表）。
     * 无论有没有候选，都会刷新本会话 L1 摘要（来自 turn.summary）。
     */
    ingestTurn({ conversationId, turnId, userText }) {
      const settings = loadSettings();
      if (!settings.enabled) return { ingested: 0, items: [], skipped: 'disabled' };
      if (!conversationId) return { ingested: 0, items: [], skipped: 'no_conversation' };
      if (isExcluded(conversationId)) return { ingested: 0, items: [], skipped: 'excluded' };

      const candidates = extractCandidates(userText);
      const now = Date.now();
      const items = [];
      tx(db, () => {
        for (const c of candidates) {
          const item = upsertCandidate(c, { conversationId, turnId }, now, settings.confidenceThreshold);
          if (item) items.push(item);
        }
        if (items.length) rebuildProfile(settings);
      });
      const summary = this.rebuildSummary(conversationId);
      return { ingested: items.length, items, summary: summary?.summary || '' };
    },

    getSummary(conversationId) {
      if (!conversationId) return null;
      const row = q.getSummary.get(conversationId);
      return row ? { conversationId: row.conversation_id, summary: row.summary, updatedAt: row.updated_at } : null;
    },

    /** 从本会话已完成轮次的 summary 字段重建 L1（不读 user_text / raw） */
    rebuildSummary(conversationId) {
      if (!conversationId || !q.convLive.get(conversationId)) return null;
      if (isExcluded(conversationId)) {
        q.deleteSummary.run(conversationId);
        return { conversationId, summary: '', updatedAt: Date.now() };
      }
      const rows = q.turnSummaries.all(conversationId);
      const parsed = rows.map((r) => {
        try {
          return JSON.parse(r.summary || '[]');
        } catch (e) {
          return [];
        }
      });
      const text = composeSessionSummary(parsed);
      const now = Date.now();
      if (!text) {
        q.deleteSummary.run(conversationId);
        return { conversationId, summary: '', updatedAt: now };
      }
      q.putSummary.run(conversationId, text, now);
      return { conversationId, summary: text, updatedAt: now };
    },

    /**
     * 对全部未否决条目做一次半衰期衰减。
     * confirmed 衰减后若低于门槛 → active；active 低于门槛一半 → candidate。
     */
    decay({ now = Date.now(), threshold } = {}) {
      const settings = loadSettings();
      const gate = threshold != null ? clamp01(Number(threshold)) : settings.confidenceThreshold;
      let updated = 0;
      let demoted = 0;
      tx(db, () => {
        for (const r of q.decayTargets.all()) {
          const next = decayedConfidence(r.confidence, r.last_seen, r.half_life, now);
          // 距离上次见到不足 1 天且分数几乎没变：跳过写库
          if (Math.abs(next - r.confidence) < 0.001) continue;
          let status = r.status;
          if (status === 'confirmed' && next < gate) {
            status = 'active';
            demoted++;
          } else if (status === 'active' && next < gate * 0.5) {
            status = 'candidate';
            demoted++;
          }
          q.updateDecay.run(next, status, now, r.id);
          updated++;
        }
        q.putSetting.run(DECAY_KEY, String(now), now);
      });
      return { updated, demoted, at: now };
    },

    /** 距上次衰减超过一天才跑；列表 / prompt 注入前调用 */
    maybeDecay() {
      const row = q.getSetting.get(DECAY_KEY);
      const last = row && row.value ? Number(row.value) : 0;
      if (Number.isFinite(last) && Date.now() - last < DECAY_INTERVAL_MS) {
        return { updated: 0, demoted: 0, skipped: true, lastAt: last || null };
      }
      return this.decay();
    },

    /** 给 system prompt 用的短块：高置信 L2，限条数 */
    promptBlock({ limit = 12 } = {}) {
      this.maybeDecay();
      const settings = loadSettings();
      if (!settings.enabled) return '';
      const n = Math.max(1, Math.min(40, Number(limit) || 12));
      const rows = q.list.all(n).filter((r) => r.status === 'confirmed' || (r.status === 'active' && r.confidence >= settings.confidenceThreshold));
      if (!rows.length) return '';
      const lines = rows.slice(0, n).map((r) => `- (${r.type}) ${r.statement}`);
      return `## 关于用户的已知信息（来自跨会话记忆，可能过时；与用户本轮话冲突时以本轮为准）\n\n${lines.join('\n')}`;
    },
  };
}
