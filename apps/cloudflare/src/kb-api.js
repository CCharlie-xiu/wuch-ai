// 知识库 AOCI（D1 异步版，对齐 apps/server/src/kb.mjs）

import { ApiError } from './errors.js';
import { fingerprint } from './memory-api.js';

const ID_RE = /^kb_[A-Za-z0-9]{4,32}$/;
const STATUSES = new Set(['active', 'archived']);
const KINDS = new Set(['doc', 'capability', 'note', 'snippet']);
const MATURITY = new Set(['draft', 'stable', 'retired']);
const NAME_MAX = 120;
const SUMMARY_MAX = 240;
const TAG_MAX = 80;
const DOMAIN_MAX = 40;
const BODY_MAX = 400_000;
const INDEX_LIMIT = 40;

const shortId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

const toSlug = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

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

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

export function createKnowledgeRepo(db, accountId) {
  if (!db) {
    return {
      lookup: async () => ({ hit: false, reason: 'none', item: null, body: '' }),
      create: async () => ({ item: null, created: false, hit: false, reason: 'none' }),
      list: async () => [],
      get: async () => null,
      search: async () => [],
      index: async () => [],
      promptBlock: async () => '',
      patch: async () => null,
      archive: async () => false,
    };
  }

  async function putBody(text) {
    const body = String(text || '');
    const hash = await sha256Hex(body);
    const size = new TextEncoder().encode(body).length;
    await db
      .prepare('INSERT OR IGNORE INTO blob (hash, body, size, mime, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(hash, body, size, 'text/markdown', Date.now())
      .run();
    return hash;
  }

  async function readBody(row) {
    if (!row?.body_hash) return '';
    const b = await db.prepare('SELECT body FROM blob WHERE hash = ?').bind(row.body_hash).first();
    return b?.body ?? '';
  }

  async function need(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new ApiError(400, '知识条目 id 形如 kb_xxxxxxxx');
    const row = accountId
      ? await db.prepare('SELECT * FROM kb_item WHERE id = ? AND account_id = ?').bind(id, accountId).first()
      : await db.prepare('SELECT * FROM kb_item WHERE id = ?').bind(id).first();
    if (!row) throw new ApiError(404, `知识条目 ${id} 不存在`);
    return row;
  }

  async function hit(row, reason) {
    const now = Date.now();
    await db.prepare('UPDATE kb_item SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?').bind(now, row.id).run();
    const item = await db.prepare('SELECT * FROM kb_item WHERE id = ?').bind(row.id).first();
    return { hit: true, reason, item: toItem(item), body: await readBody(row) };
  }

  const repo = {
    async lookup({ fileHash, title, summary } = {}) {
      for (const key of dedupKeys({ fileHash, title, summary })) {
        const row = accountId
          ? await db
              .prepare(
                "SELECT * FROM kb_item WHERE account_id = ? AND dedup_key = ? AND status != 'archived' ORDER BY confidence DESC, updated_at DESC LIMIT 1",
              )
              .bind(accountId, key)
              .first()
          : await db
              .prepare(
                "SELECT * FROM kb_item WHERE dedup_key = ? AND status != 'archived' ORDER BY confidence DESC, updated_at DESC LIMIT 1",
              )
              .bind(key)
              .first();
        if (row) return hit(row, reasonOf(key));
      }
      return { hit: false, reason: 'none', item: null, body: '' };
    },

    async create(input = {}) {
      const name = clip(input.name, NAME_MAX);
      if (!name) throw new ApiError(400, '知识条目要有名字');
      const summary = clip(input.summary, SUMMARY_MAX);
      const tag = clip(input.tag, TAG_MAX);
      const body = String(input.body || '');
      if (body.length > BODY_MAX) throw new ApiError(413, `正文太长（${body.length} 字），上限 ${BODY_MAX}`);
      if (!body.trim()) throw new ApiError(400, 'body 不能为空（要写蒸馏后的正文，不要贴原文）');

      const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : {};
      const keys = dedupKeys({ fileHash: evidence.fileHash, title: name, summary });
      for (const k of keys) {
        const row = accountId
          ? await db
              .prepare("SELECT * FROM kb_item WHERE account_id = ? AND dedup_key = ? AND status != 'archived'")
              .bind(accountId, k)
              .first()
          : await db.prepare("SELECT * FROM kb_item WHERE dedup_key = ? AND status != 'archived'").bind(k).first();
        if (row) return { ...(await hit(row, 'existing')), created: false };
      }

      const kind = KINDS.has(input.kind) ? input.kind : 'doc';
      const maturity = MATURITY.has(input.maturity) ? input.maturity : 'draft';
      const confidence = Number.isFinite(Number(input.confidence)) ? Math.max(0, Math.min(1, Number(input.confidence))) : 0.6;

      const now = Date.now();
      const id = shortId('kb_');
      const bodyHash = await putBody(body);
      const stmts = [
        db
          .prepare(
            `INSERT INTO kb_item
              (id, account_id, name, slug, tag, summary, kind, domain, maturity, dedup_key, body_hash,
               status, source_kind, confidence, hit_count, last_hit_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, NULL, ?, ?)`,
          )
          .bind(
            id,
            accountId,
            name,
            toSlug(name),
            tag,
            summary,
            kind,
            clip(input.domain, DOMAIN_MAX),
            maturity,
            keys[0] || `title:${fingerprint(name)}`,
            bodyHash,
            clip(input.sourceKind || 'conversation', 40),
            confidence,
            now,
            now,
          ),
      ];
      if (Object.keys(evidence).length) {
        stmts.push(
          db
            .prepare(
              'INSERT INTO kb_evidence (kb_id, conversation_id, turn_id, file_name, file_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .bind(
              id,
              evidence.conversationId || null,
              evidence.turnId || null,
              evidence.fileName || null,
              evidence.fileHash || null,
              now,
            ),
        );
      }
      await db.batch(stmts);
      const item = await db.prepare('SELECT * FROM kb_item WHERE id = ?').bind(id).first();
      return { hit: false, created: true, reason: 'new', item: toItem(item), body };
    },

    async list({ limit = 100, status = 'active' } = {}) {
      const n = Math.max(1, Math.min(500, Number(limit) || 100));
      let sql;
      let rows;
      if (accountId) {
        if (status === 'archived') sql = "SELECT * FROM kb_item WHERE account_id = ? AND status = 'archived' ORDER BY updated_at DESC LIMIT ?";
        else if (status === 'all') sql = 'SELECT * FROM kb_item WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?';
        else sql = "SELECT * FROM kb_item WHERE account_id = ? AND status != 'archived' ORDER BY updated_at DESC LIMIT ?";
        ({ results: rows } = await db.prepare(sql).bind(accountId, n).all());
      } else {
        if (status === 'archived') sql = "SELECT * FROM kb_item WHERE status = 'archived' ORDER BY updated_at DESC LIMIT ?";
        else if (status === 'all') sql = 'SELECT * FROM kb_item ORDER BY updated_at DESC LIMIT ?';
        else sql = "SELECT * FROM kb_item WHERE status != 'archived' ORDER BY updated_at DESC LIMIT ?";
        ({ results: rows } = await db.prepare(sql).bind(n).all());
      }
      const out = [];
      for (const r of rows || []) {
        const cnt = await db.prepare('SELECT COUNT(*) AS n FROM kb_evidence WHERE kb_id = ?').bind(r.id).first();
        out.push({ ...toItem(r), evidenceCount: cnt?.n ?? 0 });
      }
      return out;
    },

    async get(id, { withBody = true } = {}) {
      const row = await need(id);
      const cnt = await db.prepare('SELECT COUNT(*) AS n FROM kb_evidence WHERE kb_id = ?').bind(id).first();
      const { results } = await db.prepare('SELECT * FROM kb_evidence WHERE kb_id = ? ORDER BY created_at DESC').bind(id).all();
      return {
        item: { ...toItem(row), evidenceCount: cnt?.n ?? 0 },
        body: withBody ? await readBody(row) : '',
        evidence: (results || []).map(toEvidence),
      };
    },

    async search({ query, limit = 20 } = {}) {
      const term = String(query || '').trim();
      if (!term) return [];
      const like = `%${term.replace(/[%_]/g, (m) => '\\' + m)}%`;
      const n = Math.max(1, Math.min(50, Number(limit) || 20));
      const { results } = accountId
        ? await db
            .prepare(
              `SELECT * FROM kb_item
               WHERE account_id = ? AND status != 'archived'
                 AND (name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tag LIKE ? ESCAPE '\\')
               ORDER BY hit_count DESC, updated_at DESC LIMIT ?`,
            )
            .bind(accountId, like, like, like, n)
            .all()
        : await db
            .prepare(
              `SELECT * FROM kb_item
               WHERE status != 'archived'
                 AND (name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tag LIKE ? ESCAPE '\\')
               ORDER BY hit_count DESC, updated_at DESC LIMIT ?`,
            )
            .bind(like, like, like, n)
            .all();
      return (results || []).map(toItem);
    },

    async index({ limit = INDEX_LIMIT } = {}) {
      const n = Math.max(1, Math.min(80, Number(limit) || INDEX_LIMIT));
      const { results } = accountId
        ? await db
            .prepare("SELECT * FROM kb_item WHERE account_id = ? AND status != 'archived' ORDER BY hit_count DESC, updated_at DESC LIMIT ?")
            .bind(accountId, n)
            .all()
        : await db
            .prepare("SELECT * FROM kb_item WHERE status != 'archived' ORDER BY hit_count DESC, updated_at DESC LIMIT ?")
            .bind(n)
            .all();
      return (results || []).map(toItem);
    },

    async promptBlock({ limit = INDEX_LIMIT } = {}) {
      const rows = await repo.index({ limit });
      if (!rows.length) return '';
      const lines = rows.map((r) => `- ${r.name}${r.tag ? `[${r.tag}]` : ''}：${r.summary || '（没写一句话）'}（${r.id}）`);
      return `## 知识库索引（AOCI）\n\n索引里已有的内容直接引用，不要重复入库；需要正文时用 kb_get 按 id 读。\n\n${lines.join('\n')}`;
    },

    async patch(id, { name, tag, summary, status } = {}) {
      const row = await need(id);
      const nextName = name === undefined ? row.name : clip(name, NAME_MAX);
      if (!nextName) throw new ApiError(400, 'name 不能为空');
      const nextStatus = status === undefined ? row.status : String(status);
      if (!STATUSES.has(nextStatus)) throw new ApiError(400, `status 只能是 ${[...STATUSES].join(' / ')}`);
      await db
        .prepare(
          accountId
            ? 'UPDATE kb_item SET name = ?, tag = ?, summary = ?, status = ?, updated_at = ? WHERE id = ? AND account_id = ?'
            : 'UPDATE kb_item SET name = ?, tag = ?, summary = ?, status = ?, updated_at = ? WHERE id = ?',
        )
        .bind(
          ...(accountId
            ? [nextName, tag === undefined ? row.tag : clip(tag, TAG_MAX), summary === undefined ? row.summary : clip(summary, SUMMARY_MAX), nextStatus, Date.now(), id, accountId]
            : [nextName, tag === undefined ? row.tag : clip(tag, TAG_MAX), summary === undefined ? row.summary : clip(summary, SUMMARY_MAX), nextStatus, Date.now(), id]),
        )
        .run();
      const updated = await db.prepare('SELECT * FROM kb_item WHERE id = ?').bind(id).first();
      return toItem(updated);
    },

    async archive(id) {
      await need(id);
      if (accountId) {
        await db.prepare("UPDATE kb_item SET status = 'archived', updated_at = ? WHERE id = ? AND account_id = ?").bind(Date.now(), id, accountId).run();
      } else {
        await db.prepare("UPDATE kb_item SET status = 'archived', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
      }
      return true;
    },
  };

  return repo;
}

export async function handleKb(request, db, path, url, account) {
  const method = request.method;
  const kb = createKnowledgeRepo(db, account.id);
  const bodyJson = async () => {
    try {
      return await request.json();
    } catch {
      throw new ApiError(400, '请求体不是合法 JSON');
    }
  };

  if (method === 'POST' && path === '/kb/lookup') return { status: 200, body: await kb.lookup(await bodyJson()) };

  if (method === 'POST' && path === '/kb/items') return { status: 201, body: await kb.create(await bodyJson()) };

  if (method === 'GET' && path === '/kb/items') {
    return {
      status: 200,
      body: {
        items: await kb.list({
          limit: url.searchParams.get('limit'),
          status: url.searchParams.get('status') || 'active',
        }),
      },
    };
  }

  let m = /^\/kb\/items\/([^/]+)$/.exec(path);
  if (method === 'GET' && m) return { status: 200, body: await kb.get(decodeURIComponent(m[1])) };

  if (method === 'PATCH' && m) return { status: 200, body: { item: await kb.patch(decodeURIComponent(m[1]), await bodyJson()) } };

  if (method === 'DELETE' && m) {
    await kb.archive(decodeURIComponent(m[1]));
    return { status: 204, body: null };
  }

  if (method === 'POST' && path === '/kb/search') return { status: 200, body: { items: await kb.search(await bodyJson()) } };

  if (method === 'GET' && path === '/kb/index') {
    const limit = url.searchParams.get('limit');
    const items = await kb.index({ limit });
    return { status: 200, body: { items, block: await kb.promptBlock({ limit }) } };
  }

  throw new ApiError(404, '没有这个接口');
}
