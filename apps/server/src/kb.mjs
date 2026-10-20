// ─────────────────────────────────────────────────────────────────────────────
// 知识库（AOCI 条目）：索引行 + 蒸馏正文 + 证据指针。
//
// 三条约定：
//   · 存蒸馏产物，不存原文 —— 原文只留 evidence 里的会话 / 轮次 / 文件 hash
//   · 入库前先 lookup 去重：命中就直接读已有条目，不重复建
//   · 正文进 blob（按 sha256 去重，与数据集同源）；检索扫索引列（LIKE）
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { RepoError } from './db.mjs';
import { fingerprint } from './memory.mjs';

const ID_RE = /^kb_[A-Za-z0-9]{4,32}$/;
const STATUSES = new Set(['active', 'archived']);
const KINDS = new Set(['doc', 'capability', 'note', 'snippet']);
const MATURITY = new Set(['draft', 'stable', 'retired']);
const NAME_MAX = 120;
const SUMMARY_MAX = 240;
const TAG_MAX = 80;
const DOMAIN_MAX = 40;
const BODY_MAX = 400_000;
const INDEX_LIMIT = 40; // 注入 system prompt 的索引行上限

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

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

/** 标题 → slug：只留字母数字与汉字，其余折成 - */
const toSlug = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/**
 * 三级去重键，按优先级排：文件哈希 → 标题指纹 → 摘要指纹。
 * 指纹复用记忆层的 fingerprint（去空白 / 小写 / 去人称前缀），保证「同一条」判得一致。
 */
export function dedupKeys({ fileHash, title, summary } = {}) {
  const keys = [];
  const h = String(fileHash || '').trim().toLowerCase();
  if (/^[a-f0-9]{16,128}$/.test(h)) keys.push(`file:${h}`);
  const t = fingerprint(title);
  if (t) keys.push(`title:${t}`);
  const s = fingerprint(summary);
  if (s) keys.push(`sum:${s}`);
  return keys;
}

const reasonOf = (key) => (key.startsWith('file:') ? 'file' : key.startsWith('title:') ? 'title' : 'summary');

function toItem(r) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    tag: r.tag,
    summary: r.summary,
    kind: r.kind,
    domain: r.domain,
    maturity: r.maturity,
    status: r.status,
    sourceKind: r.source_kind,
    confidence: r.confidence,
    hitCount: r.hit_count,
    lastHitAt: r.last_hit_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toEvidence(r) {
  return {
    id: r.id,
    conversationId: r.conversation_id || null,
    turnId: r.turn_id || null,
    fileName: r.file_name || null,
    fileHash: r.file_hash || null,
    createdAt: r.created_at,
  };
}

/** 没有数据库时的空实现：接口照常能挂，只是什么都不存 */
const NOOP = {
  lookup: () => ({ hit: false, reason: 'none', item: null, body: '' }),
  create: () => ({ item: null, created: false, hit: false, reason: 'none' }),
  list: () => [],
  get: () => null,
  search: () => [],
  index: () => [],
  promptBlock: () => '',
  patch: () => null,
  archive: () => false,
};

export function createKnowledgeRepo(db) {
  if (!db) return NOOP;

  const q = {
    putBlob: db.prepare('INSERT OR IGNORE INTO blob (hash, body, size, mime, created_at) VALUES (?, ?, ?, ?, ?)'),
    blob: db.prepare('SELECT body FROM blob WHERE hash = ?'),
    get: db.prepare('SELECT * FROM kb_item WHERE id = ?'),
    byDedup: db.prepare(
      "SELECT * FROM kb_item WHERE dedup_key = ? AND status != 'archived' ORDER BY confidence DESC, updated_at DESC LIMIT 1",
    ),
    insert: db.prepare(
      `INSERT INTO kb_item
        (id, name, slug, tag, summary, kind, domain, maturity, dedup_key, body_hash,
         status, source_kind, confidence, hit_count, last_hit_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, NULL, ?, ?)`,
    ),
    listActive: db.prepare("SELECT * FROM kb_item WHERE status != 'archived' ORDER BY updated_at DESC LIMIT ?"),
    listArchived: db.prepare("SELECT * FROM kb_item WHERE status = 'archived' ORDER BY updated_at DESC LIMIT ?"),
    listAll: db.prepare('SELECT * FROM kb_item ORDER BY updated_at DESC LIMIT ?'),
    search: db.prepare(
      `SELECT * FROM kb_item
       WHERE status != 'archived'
         AND (name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tag LIKE ? ESCAPE '\\')
       ORDER BY hit_count DESC, updated_at DESC LIMIT ?`,
    ),
    index: db.prepare(
      "SELECT * FROM kb_item WHERE status != 'archived' ORDER BY hit_count DESC, updated_at DESC LIMIT ?",
    ),
    touchHit: db.prepare('UPDATE kb_item SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?'),
    update: db.prepare('UPDATE kb_item SET name = ?, tag = ?, summary = ?, status = ?, updated_at = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE kb_item SET status = ?, updated_at = ? WHERE id = ?'),
    insertEvidence: db.prepare(
      'INSERT INTO kb_evidence (kb_id, conversation_id, turn_id, file_name, file_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    evidence: db.prepare('SELECT * FROM kb_evidence WHERE kb_id = ? ORDER BY created_at DESC'),
    evidenceCount: db.prepare('SELECT COUNT(*) AS n FROM kb_evidence WHERE kb_id = ?'),
  };

  function putBody(text) {
    const buf = Buffer.from(String(text || ''), 'utf8');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    q.putBlob.run(hash, buf, buf.length, 'text/markdown', Date.now());
    return hash;
  }

  function readBody(row) {
    if (!row || !row.body_hash) return '';
    const b = q.blob.get(row.body_hash);
    return b ? Buffer.from(b.body).toString('utf8') : '';
  }

  function need(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new RepoError(400, '知识条目 id 形如 kb_xxxxxxxx');
    const row = q.get.get(id);
    if (!row) throw new RepoError(404, `知识条目 ${id} 不存在`);
    return row;
  }

  function hit(row, reason) {
    const now = Date.now();
    q.touchHit.run(now, row.id);
    return { hit: true, reason, item: toItem(q.get.get(row.id)), body: readBody(row) };
  }

  return {
    /**
     * 去重检索：按 file → title → summary 顺序找。命中顺手记一次命中数，
     * 并把正文一起返回 —— 「命中就直接读 aoci」靠的就是这个。
     */
    lookup({ fileHash, title, summary } = {}) {
      for (const key of dedupKeys({ fileHash, title, summary })) {
        const row = q.byDedup.get(key);
        if (row) return hit(row, reasonOf(key));
      }
      return { hit: false, reason: 'none', item: null, body: '' };
    },

    /**
     * 建条目。内部再跑一次 lookup 兜底：命中就直接返回已有条目，不重复建。
     * body 是蒸馏正文（markdown）；evidence 记来源指针（会话 / 轮次 / 文件名 / 文件 hash）。
     */
    create(input = {}) {
      const name = clip(input.name, NAME_MAX);
      if (!name) throw new RepoError(400, '知识条目要有名字');
      const summary = clip(input.summary, SUMMARY_MAX);
      const tag = clip(input.tag, TAG_MAX);
      const body = String(input.body || '');
      if (body.length > BODY_MAX) throw new RepoError(413, `正文太长（${body.length} 字），上限 ${BODY_MAX}`);
      if (!body.trim()) throw new RepoError(400, 'body 不能为空（要写蒸馏后的正文，不要贴原文）');

      const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : {};
      const keys = dedupKeys({ fileHash: evidence.fileHash, title: name, summary });
      const existing = keys.map((k) => q.byDedup.get(k)).find(Boolean);
      if (existing) return { ...hit(existing, 'existing'), created: false };

      const kind = KINDS.has(input.kind) ? input.kind : 'doc';
      const maturity = MATURITY.has(input.maturity) ? input.maturity : 'draft';
      const confidence = Number.isFinite(Number(input.confidence)) ? Math.max(0, Math.min(1, Number(input.confidence))) : 0.6;

      return tx(db, () => {
        const now = Date.now();
        const id = shortId('kb_');
        q.insert.run(
          id,
          name,
          toSlug(name),
          tag,
          summary,
          kind,
          clip(input.domain, DOMAIN_MAX),
          maturity,
          keys[0] || `title:${fingerprint(name)}`,
          putBody(body),
          clip(input.sourceKind || 'conversation', 40),
          confidence,
          now,
          now,
        );
        if (Object.keys(evidence).length) {
          q.insertEvidence.run(
            id,
            evidence.conversationId || null,
            evidence.turnId || null,
            evidence.fileName || null,
            evidence.fileHash || null,
            now,
          );
        }
        return { hit: false, created: true, reason: 'new', item: toItem(q.get.get(id)), body };
      });
    },

    /** status: active（默认，不含归档）/ archived / all */
    list({ limit = 100, status = 'active' } = {}) {
      const n = Math.max(1, Math.min(500, Number(limit) || 100));
      const rows = status === 'archived' ? q.listArchived.all(n) : status === 'all' ? q.listAll.all(n) : q.listActive.all(n);
      return rows.map((r) => ({ ...toItem(r), evidenceCount: q.evidenceCount.get(r.id).n }));
    },

    get(id, { withBody = true } = {}) {
      const row = need(id);
      return {
        item: { ...toItem(row), evidenceCount: q.evidenceCount.get(row.id).n },
        body: withBody ? readBody(row) : '',
        evidence: q.evidence.all(id).map(toEvidence),
      };
    },

    /** 索引检索：只扫 name / summary / tag —— 正文要用 kb_get 单独取 */
    search({ query, limit = 20 } = {}) {
      const term = String(query || '').trim();
      if (!term) return [];
      const like = `%${term.replace(/[%_]/g, (m) => '\\' + m)}%`;
      return q.search.all(like, like, like, Math.max(1, Math.min(50, Number(limit) || 20))).map(toItem);
    },

    index({ limit = INDEX_LIMIT } = {}) {
      return q.index.all(Math.max(1, Math.min(80, Number(limit) || INDEX_LIMIT))).map(toItem);
    },

    /** 给 system prompt 用的索引块：一行一条，仿 memory.promptBlock */
    promptBlock({ limit = INDEX_LIMIT } = {}) {
      const rows = this.index({ limit });
      if (!rows.length) return '';
      const lines = rows.map((r) => `- ${r.name}${r.tag ? `[${r.tag}]` : ''}：${r.summary || '（没写一句话）'}（${r.id}）`);
      return `## 知识库索引（AOCI）\n\n索引里已有的内容直接引用，不要重复入库；需要正文时用 kb_get 按 id 读。\n\n${lines.join('\n')}`;
    },

    patch(id, { name, tag, summary, status } = {}) {
      const row = need(id);
      const nextName = name === undefined ? row.name : clip(name, NAME_MAX);
      if (!nextName) throw new RepoError(400, 'name 不能为空');
      const nextStatus = status === undefined ? row.status : String(status);
      if (!STATUSES.has(nextStatus)) throw new RepoError(400, `status 只能是 ${[...STATUSES].join(' / ')}`);
      q.update.run(
        nextName,
        tag === undefined ? row.tag : clip(tag, TAG_MAX),
        summary === undefined ? row.summary : clip(summary, SUMMARY_MAX),
        nextStatus,
        Date.now(),
        id,
      );
      return toItem(q.get.get(id));
    },

    /** 软删：置为 archived，列表默认看不到 */
    archive(id) {
      need(id);
      q.setStatus.run('archived', Date.now(), id);
      return true;
    },
  };
}
