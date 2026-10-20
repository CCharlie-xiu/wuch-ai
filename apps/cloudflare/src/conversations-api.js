import { ApiError } from './errors.js';
import { createMemoryRepo } from './memory-api.js';
import { conversationSkillIds, setConversationSkills } from './skills-api.js';
import { listDatasetsForConversation } from './datasets-api.js';

const HISTORY_TURNS = 4;
const TITLE_MAX = 40;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = new Set(['complete', 'error', 'cancelled']);
const MODES = new Set(['new', 'edit', 'user']);
const HEAD_OPS = new Set(['back', 'forward', 'checkout', 'switch']);
const FILE_HEAD_RE = /^【文件 (.+?)(?:｜sha256 [0-9a-f]{8,128})?】/;

const parse = (s) => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const json = (v) => (v == null ? null : JSON.stringify(v));

function titleOf(userText) {
  const src = String(userText || '');
  const names = [];
  const said = [];
  let inFile = false;
  for (const line of src.split('\n')) {
    const m = FILE_HEAD_RE.exec(line);
    if (m) {
      names.push(m[1]);
      inFile = true;
      continue;
    }
    if (!inFile) said.push(line);
  }
  const base = said.join('\n').trim() || names.join('、');
  return (base || src.trim()).slice(0, TITLE_MAX);
}

const toConversation = (r) => ({
  id: r.id,
  title: r.title,
  turnCount: r.turn_count,
  headTurnId: r.head_turn_id ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toTurn = (r) => ({
  id: r.id,
  seq: r.seq,
  parentId: r.parent_id ?? null,
  activeChildId: r.active_child_id ?? null,
  depth: r.depth ?? r.seq,
  mode: r.mode || 'new',
  userText: r.user_text,
  raw: r.raw,
  snapshot: r.snapshot ?? r.raw,
  refs: parse(r.refs) || {},
  skills: parse(r.skills) || [],
  state: r.state,
  summary: parse(r.summary),
  failure: r.failure,
  replay: parse(r.replay),
  model: r.model,
  createdAt: r.created_at,
});

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ApiError(400, '会话 id 只能是 1–64 位字母、数字、- 或 _');
}

function checkTurn(t) {
  if (!t || typeof t.userText !== 'string' || !t.userText.trim()) throw new ApiError(400, 'userText 不能为空');
  if (!STATES.has(t.state)) throw new ApiError(400, `state 只能是 ${[...STATES].join(' / ')}`);
  if (t.mode != null && !MODES.has(t.mode)) throw new ApiError(400, `mode 只能是 ${[...MODES].join(' / ')}`);
}

async function live(db, id, accountId) {
  const row = await db.prepare('SELECT * FROM conversation WHERE id = ? AND user_id = ?').bind(id, accountId).first();
  return row && row.deleted_at == null ? row : null;
}

async function getTurn(db, turnId, conversationId) {
  return db.prepare('SELECT * FROM turn WHERE id = ? AND conversation_id = ?').bind(turnId, conversationId).first();
}

async function pathToHead(db, headId, conversationId) {
  if (!headId) return [];
  const { results } = await db
    .prepare(
      `WITH RECURSIVE up(id, parent_id, depth) AS (
         SELECT id, parent_id, depth FROM turn WHERE id = ? AND conversation_id = ?
         UNION ALL
         SELECT t.id, t.parent_id, t.depth FROM turn t JOIN up ON t.id = up.parent_id
       )
       SELECT id FROM up ORDER BY depth`,
    )
    .bind(headId, conversationId)
    .all();
  return (results || []).map((r) => r.id);
}

async function tipOf(db, conversationId, from) {
  let cur = from;
  const seen = new Set([cur.id]);
  while (cur.active_child_id && !seen.has(cur.active_child_id)) {
    const next = await getTurn(db, cur.active_child_id, conversationId);
    if (!next) break;
    seen.add(next.id);
    cur = next;
  }
  return cur;
}

async function alignPath(db, conversationId, targetId) {
  const ids = await pathToHead(db, targetId, conversationId);
  const stmts = [];
  for (let i = 1; i < ids.length; i++) {
    stmts.push(db.prepare('UPDATE turn SET active_child_id = ? WHERE id = ?').bind(ids[i], ids[i - 1]));
  }
  if (stmts.length) await db.batch(stmts);
}

async function buildConversation(db, id, accountId) {
  const row = await live(db, id, accountId);
  if (!row) return null;
  const { results } = await db.prepare('SELECT * FROM turn WHERE conversation_id = ? ORDER BY seq').bind(id).all();
  const turns = (results || []).map(toTurn);
  const byId = new Map(turns.map((t) => [t.id, t]));
  const headId = row.head_turn_id && byId.has(row.head_turn_id) ? row.head_turn_id : turns.at(-1)?.id ?? null;
  const path = headId ? await pathToHead(db, headId, id) : [];
  const chain = [...path];
  const seen = new Set(chain);
  for (let cur = byId.get(headId); cur && cur.activeChildId && byId.has(cur.activeChildId) && !seen.has(cur.activeChildId); ) {
    cur = byId.get(cur.activeChildId);
    chain.push(cur.id);
    seen.add(cur.id);
  }
  const kids = new Map();
  for (const t of turns) {
    const k = t.parentId ?? '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(t.id);
  }
  for (const t of turns) t.siblings = kids.get(t.parentId ?? '');
  const history = path
    .map((tid) => byId.get(tid))
    .filter((t) => t && t.state === 'complete' && t.raw)
    .slice(-HISTORY_TURNS)
    .flatMap((t) => [
      { role: 'user', content: t.userText },
      { role: 'assistant', content: t.raw },
    ]);
  return { ...toConversation(row), headTurnId: headId, turns, path, chain, history };
}

export async function handleConversations(request, db, path, url, account) {
  const accountId = account.id;
  const method = request.method;
  const bodyJson = async () => {
    try {
      return await request.json();
    } catch {
      throw new ApiError(400, '请求体不是合法 JSON');
    }
  };

  if (method === 'GET' && path === '/conversations') {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
    const before = Number(url.searchParams.get('before'));
    const cursor = before > 0 ? before : Number.MAX_SAFE_INTEGER;
    const { results } = await db
      .prepare(
        'SELECT * FROM conversation WHERE deleted_at IS NULL AND user_id = ? AND updated_at < ? ORDER BY updated_at DESC LIMIT ?',
      )
      .bind(accountId, cursor, limit)
      .all();
    return { status: 200, body: { conversations: (results || []).map(toConversation) } };
  }

  const m = /^\/conversations\/([^/]+)(?:\/(turns|head|head-log|skills|datasets|summary|metrics)(?:\/(rebuild))?)?$/.exec(path);
  if (!m) throw new ApiError(404, '没有这个接口');
  const id = decodeURIComponent(m[1]);
  const sub = m[2];
  const subAction = m[3];
  const memory = createMemoryRepo(db, accountId);

  if (method === 'GET' && !sub) {
    const conversation = await buildConversation(db, id, accountId);
    return conversation ? { status: 200, body: { conversation } } : { status: 404, body: { error: '会话不存在' } };
  }

  if (method === 'PATCH' && !sub) {
    checkId(id);
    const { title } = await bodyJson();
    if (typeof title !== 'string' || !title.trim()) throw new ApiError(400, 'title 不能为空');
    const r = await db
      .prepare('UPDATE conversation SET title = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(title.trim().slice(0, TITLE_MAX), Date.now(), id, accountId)
      .run();
    return r.meta.changes ? { status: 204, body: null } : { status: 404, body: { error: '会话不存在' } };
  }

  if (method === 'DELETE' && !sub) {
    checkId(id);
    const r = await db
      .prepare('UPDATE conversation SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(Date.now(), id, accountId)
      .run();
    return r.meta.changes ? { status: 204, body: null } : { status: 404, body: { error: '会话不存在' } };
  }

  if (method === 'POST' && sub === 'turns') {
    checkId(id);
    const t = await bodyJson();
    checkTurn(t);
    const now = Date.now();
    let row = await db.prepare('SELECT * FROM conversation WHERE id = ?').bind(id).first();
    if (row && row.user_id && row.user_id !== accountId) throw new ApiError(404, '会话不存在');
    if (row && row.deleted_at != null) throw new ApiError(409, '这个会话已经删除了');
    const stmts = [];
    if (!row) {
      stmts.push(
        db
          .prepare('INSERT INTO conversation (id, user_id, title, turn_count, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
          .bind(id, accountId, titleOf(t.userText), now, now),
      );
    } else if (!row.user_id) {
      stmts.push(db.prepare('UPDATE conversation SET user_id = ? WHERE id = ?').bind(accountId, id));
    }
    // 需要先拿到最新 row；若刚 insert，先 batch 再读
    if (stmts.length) await db.batch(stmts);
    row = await db.prepare('SELECT * FROM conversation WHERE id = ?').bind(id).first();

    const parentId = t.parentId === undefined ? row.head_turn_id : t.parentId;
    const parent = parentId ? await getTurn(db, parentId, id) : null;
    if (parentId && !parent) throw new ApiError(400, `上一轮 ${parentId} 不在这个会话里`);
    const snapshot = typeof t.snapshot === 'string' ? t.snapshot : t.raw || parent?.snapshot || '';
    const refs = { ...(parse(parent?.refs) || {}), ...(t.refs || {}) };
    const turnId = crypto.randomUUID();
    const seq = row.turn_count + 1;
    const depth = (parent?.depth ?? 0) + 1;
    const writes = [
      db
        .prepare(
          `INSERT INTO turn (id, conversation_id, seq, parent_id, depth, mode, user_text, raw, snapshot, refs, skills,
                             state, summary, failure, replay, model, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          turnId,
          id,
          seq,
          parent?.id ?? null,
          depth,
          t.mode || 'new',
          t.userText,
          typeof t.raw === 'string' ? t.raw : '',
          snapshot,
          json(refs),
          json(t.skills || []),
          t.state,
          json(t.summary),
          t.failure || null,
          json(t.replay),
          t.model || null,
          t.createdAt || now,
          now,
        ),
      db.prepare('UPDATE conversation SET head_turn_id = ?, turn_count = turn_count + 1, updated_at = ? WHERE id = ?').bind(turnId, now, id),
      db
        .prepare('INSERT INTO head_log (conversation_id, from_turn_id, to_turn_id, op, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, row.head_turn_id, turnId, 'commit', now),
    ];
    if (parent) writes.push(db.prepare('UPDATE turn SET active_child_id = ? WHERE id = ?').bind(turnId, parent.id));
    await db.batch(writes);
    const conversation = toConversation(await db.prepare('SELECT * FROM conversation WHERE id = ?').bind(id).first());
    const turn = toTurn(await getTurn(db, turnId, id));
    const out = { conversation, turnId, turn };
    if (t.metrics) await memory.recordMetrics(id, turnId, t.metrics);
    out.memory = await memory.ingestTurn({ conversationId: id, turnId, userText: t.userText });
    return { status: 201, body: out };
  }

  if (method === 'POST' && sub === 'head') {
    checkId(id);
    const { op, turnId } = await bodyJson();
    if (!HEAD_OPS.has(op)) throw new ApiError(400, `op 只能是 ${[...HEAD_OPS].join(' / ')}`);
    const row = await live(db, id, accountId);
    if (!row) throw new ApiError(404, '会话不存在');
    const head = row.head_turn_id ? await getTurn(db, row.head_turn_id, id) : null;
    let target;
    if (op === 'back') {
      if (!head || !head.parent_id) throw new ApiError(409, '已经是第一版了');
      target = await getTurn(db, head.parent_id, id);
    } else if (op === 'forward') {
      if (!head || !head.active_child_id) throw new ApiError(409, '已经是这一支的最新一版了');
      target = await getTurn(db, head.active_child_id, id);
    } else {
      if (typeof turnId !== 'string' || !turnId) throw new ApiError(400, `${op} 要带 turnId`);
      const picked = await getTurn(db, turnId, id);
      if (!picked) throw new ApiError(404, '这一轮不在这个会话里');
      target = op === 'switch' ? await tipOf(db, id, picked) : picked;
    }
    if (!target) throw new ApiError(409, '目标版本不存在');
    await alignPath(db, id, target.id);
    const now = Date.now();
    await db.batch([
      db.prepare('UPDATE conversation SET head_turn_id = ?, updated_at = ? WHERE id = ?').bind(target.id, now, id),
      db
        .prepare('INSERT INTO head_log (conversation_id, from_turn_id, to_turn_id, op, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, row.head_turn_id, target.id, op, now),
    ]);
    return { status: 200, body: { conversation: await buildConversation(db, id, accountId) } };
  }

  if (method === 'GET' && sub === 'head-log') {
    if (!(await live(db, id, accountId))) return { status: 404, body: { error: '会话不存在' } };
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 50));
    const { results } = await db
      .prepare('SELECT * FROM head_log WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
      .bind(id, limit)
      .all();
    return {
      status: 200,
      body: {
        log: (results || []).map((r) => ({
          fromTurnId: r.from_turn_id,
          toTurnId: r.to_turn_id,
          op: r.op,
          createdAt: r.created_at,
        })),
      },
    };
  }

  if (method === 'GET' && sub === 'skills') {
    if (!(await live(db, id, accountId))) return { status: 404, body: { error: '会话不存在' } };
    return { status: 200, body: { skills: await conversationSkillIds(db, id) } };
  }
  if (method === 'PUT' && sub === 'skills') {
    if (!(await live(db, id, accountId))) return { status: 404, body: { error: '会话不存在' } };
    const { skills } = await bodyJson();
    const ok = await setConversationSkills(db, id, skills);
    return ok ? { status: 204, body: null } : { status: 404, body: { error: '会话不存在' } };
  }
  if (method === 'GET' && sub === 'datasets') {
    if (!(await live(db, id, accountId))) return { status: 404, body: { error: '会话不存在' } };
    return { status: 200, body: { datasets: await listDatasetsForConversation(db, id, accountId) } };
  }
  if (method === 'GET' && sub === 'metrics') {
    if (!(await live(db, id, accountId))) return { status: 404, body: { error: '会话不存在' } };
    return { status: 200, body: await memory.metricsFor(id) };
  }
  if (method === 'GET' && sub === 'summary' && !subAction) {
    if (!(await live(db, id, accountId))) return { status: 404, body: { error: '会话不存在' } };
    const summary = await memory.getSummary(id);
    return summary
      ? { status: 200, body: summary }
      : { status: 200, body: { conversationId: id, summary: '', updatedAt: null } };
  }
  if (method === 'POST' && sub === 'summary' && subAction === 'rebuild') {
    if (!(await live(db, id, accountId))) return { status: 404, body: { error: '会话不存在' } };
    const summary = await memory.rebuildSummary(id);
    return summary ? { status: 200, body: summary } : { status: 404, body: { error: '会话不存在' } };
  }

  throw new ApiError(404, '没有这个接口');
}
