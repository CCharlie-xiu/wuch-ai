// ─────────────────────────────────────────────────────────────────────────────
// 本地库：node:sqlite 连接 + 会话读写。迁移见 migrate.mjs。
//
//   await openDb()              默认 apps/server/data/openui.db，可用 OPENUI_DB 覆盖，
//                               测试传 ':memory:'
//   createConversationRepo(db)  会话列表 / 会话记录的全部读写都走这里
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.mjs';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const DEFAULT_DB_FILE = path.join(DATA_DIR, 'openui.db');

/** 模型上下文带最近几轮（每轮 user + assistant 两条），与前端 session.js 的 8 条上限一致 */
const HISTORY_TURNS = 4;
const TITLE_MAX = 40;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = new Set(['complete', 'error', 'cancelled']);

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

export async function openDb(file = process.env.OPENUI_DB || DEFAULT_DB_FILE, { dataDir = DATA_DIR } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 3000');
  try {
    await migrate(db, dataDir);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

export class RepoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s) => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
};

const MODES = new Set(['new', 'edit', 'user']);
const HEAD_OPS = new Set(['back', 'forward', 'checkout', 'switch']);

// 附件正文块的头：与 apps/web/src/attachments.js 的 build() / splitFileBlocks 同一格式
const FILE_HEAD_RE = /^【文件 (.+?)(?:｜sha256 [0-9a-f]{8,128})?】/;

/**
 * 会话标题：附件正文不算数。前端把文件内容拼在消息尾部（【文件 …】块），
 * 直接截前 40 字的话，一份两万字的 md 会把标题整个冲掉。只传了文件没写字时，
 * 拿文件名顶上。
 */
export function titleOf(userText) {
  const src = String(userText || '');
  const names = [];
  const said = [];
  let inFile = false;
  for (const line of src.split('\n')) {
    const m = FILE_HEAD_RE.exec(line);
    if (m) {
      names.push(m[1]);
      inFile = true; // 文件块一律在尾部，从这里往后都是附件内容
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

export function createConversationRepo(db) {
  const q = {
    list: db.prepare(
      'SELECT * FROM conversation WHERE deleted_at IS NULL AND updated_at < ? ORDER BY updated_at DESC LIMIT ?',
    ),
    get: db.prepare('SELECT * FROM conversation WHERE id = ?'),
    turns: db.prepare('SELECT * FROM turn WHERE conversation_id = ? ORDER BY seq'),
    turn: db.prepare('SELECT * FROM turn WHERE id = ? AND conversation_id = ?'),
    // 第一轮 → HEAD 的路径（递归往上找父节点）
    path: db.prepare(
      `WITH RECURSIVE up(id, parent_id, depth) AS (
         SELECT id, parent_id, depth FROM turn WHERE id = ? AND conversation_id = ?
         UNION ALL
         SELECT t.id, t.parent_id, t.depth FROM turn t JOIN up ON t.id = up.parent_id
       )
       SELECT id FROM up ORDER BY depth`,
    ),
    insertConv: db.prepare(
      'INSERT INTO conversation (id, title, turn_count, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
    ),
    insertTurn: db.prepare(
      `INSERT INTO turn (id, conversation_id, seq, parent_id, depth, mode, user_text, raw, snapshot, refs, skills,
                         state, summary, failure, replay, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    bump: db.prepare('UPDATE conversation SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?'),
    setHead: db.prepare('UPDATE conversation SET head_turn_id = ? WHERE id = ?'),
    setActiveChild: db.prepare('UPDATE turn SET active_child_id = ? WHERE id = ?'),
    log: db.prepare('INSERT INTO head_log (conversation_id, from_turn_id, to_turn_id, op, created_at) VALUES (?, ?, ?, ?, ?)'),
    rename: db.prepare('UPDATE conversation SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'),
    remove: db.prepare('UPDATE conversation SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
  };

  function live(id) {
    const row = q.get.get(id);
    return row && row.deleted_at == null ? row : null;
  }

  function checkId(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new RepoError(400, '会话 id 只能是 1–64 位字母、数字、- 或 _');
  }

  function checkTurn(t) {
    if (!t || typeof t.userText !== 'string' || !t.userText.trim()) throw new RepoError(400, 'userText 不能为空');
    if (!STATES.has(t.state)) throw new RepoError(400, `state 只能是 ${[...STATES].join(' / ')}`);
    if (t.mode != null && !MODES.has(t.mode)) throw new RepoError(400, `mode 只能是 ${[...MODES].join(' / ')}`);
    if (t.refs != null && (typeof t.refs !== 'object' || Array.isArray(t.refs))) throw new RepoError(400, 'refs 必须是 { 数据集 id: 版本 id }');
    if (t.skills != null && !Array.isArray(t.skills)) throw new RepoError(400, 'skills 必须是数组');
  }

  /** tree：父节点与它算出来的深度 / 快照 / 数据引用 */
  function insertTurn(conversationId, seq, t, now, tree) {
    const id = crypto.randomUUID();
    q.insertTurn.run(
      id,
      conversationId,
      seq,
      tree.parentId,
      tree.depth,
      t.mode || 'new',
      t.userText,
      typeof t.raw === 'string' ? t.raw : '',
      tree.snapshot,
      json(tree.refs),
      json(t.skills || []),
      t.state,
      json(t.summary),
      t.failure || null,
      json(t.replay),
      t.model || null,
      t.createdAt || now,
      now,
    );
    return id;
  }

  /** 沿 active_child 从 from 一路走到这一支的最新一轮 */
  function tipOf(conversationId, from) {
    let cur = from;
    const seen = new Set([cur.id]);
    while (cur.active_child_id && !seen.has(cur.active_child_id)) {
      const next = q.turn.get(cur.active_child_id, conversationId);
      if (!next) break;
      seen.add(next.id);
      cur = next;
    }
    return cur;
  }

  /** 让第一轮到 target 这条路径上每一轮的 active_child 都指向路径上的下一轮 */
  function alignPath(conversationId, targetId) {
    const ids = q.path.all(targetId, conversationId).map((r) => r.id);
    for (let i = 1; i < ids.length; i++) q.setActiveChild.run(ids[i], ids[i - 1]);
  }

  return {
    /** 会话列表：按最近更新倒序，before 传上一页最后一条的 updatedAt 翻页 */
    list({ limit = 50, before } = {}) {
      const n = Math.max(1, Math.min(200, Number(limit) || 50));
      const cursor = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
      return q.list.all(cursor, n).map(toConversation);
    },

    /**
     * 单个会话：
     *   turns    全部轮次（整棵树），每轮带 siblings（同一个父节点下的各个分支，按先后）
     *   path     第一轮 → HEAD：画布当前版本是怎么来的，也是模型上下文的来源
     *   chain    path 再沿 active_child 往后走到这一支的最新一轮：聊天区显示的就是它，HEAD 之后的置灰
     *   history  path 上最近几轮完成的问答
     */
    get(id) {
      const row = live(id);
      if (!row) return null;
      const turns = q.turns.all(id).map(toTurn);
      const byId = new Map(turns.map((t) => [t.id, t]));
      const headId = row.head_turn_id && byId.has(row.head_turn_id) ? row.head_turn_id : turns.at(-1)?.id ?? null;
      const path = headId ? q.path.all(headId, id).map((r) => r.id) : [];
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
        .filter((t) => t.state === 'complete' && t.raw)
        .slice(-HISTORY_TURNS)
        .flatMap((t) => [
          { role: 'user', content: t.userText },
          { role: 'assistant', content: t.raw },
        ]);
      return { ...toConversation(row), headTurnId: headId, turns, path, chain, history };
    },

    /**
     * 追加一轮；会话不存在就用第一句话做标题一并建出来。
     * 父节点默认是 HEAD：回退后再发消息，就从 HEAD 长出一个新分支。新一轮成为 HEAD。
     * snapshot 不传时取 raw（没写出东西就沿用父节点）；refs 在父节点基础上覆盖。
     */
    appendTurn(conversationId, t) {
      checkId(conversationId);
      checkTurn(t);
      return tx(db, () => {
        const now = Date.now();
        let row = q.get.get(conversationId);
        if (row && row.deleted_at != null) throw new RepoError(409, '这个会话已经删除了');
        if (!row) {
          q.insertConv.run(conversationId, titleOf(t.userText), now, now);
          row = q.get.get(conversationId);
        }
        const parentId = t.parentId === undefined ? row.head_turn_id : t.parentId;
        const parent = parentId ? q.turn.get(parentId, conversationId) : null;
        if (parentId && !parent) throw new RepoError(400, `上一轮 ${parentId} 不在这个会话里`);
        const snapshot = typeof t.snapshot === 'string' ? t.snapshot : t.raw || parent?.snapshot || '';
        const refs = { ...(parse(parent?.refs) || {}), ...(t.refs || {}) };
        const id = insertTurn(conversationId, row.turn_count + 1, t, now, { parentId: parent?.id ?? null, depth: (parent?.depth ?? 0) + 1, snapshot, refs });
        if (parent) q.setActiveChild.run(id, parent.id);
        q.setHead.run(id, conversationId);
        q.log.run(conversationId, row.head_turn_id, id, 'commit', now);
        q.bump.run(now, conversationId);
        return { conversation: toConversation(q.get.get(conversationId)), turnId: id, turn: toTurn(q.turn.get(id, conversationId)) };
      });
    },

    /**
     * 移动 HEAD（画布版本）：
     *   back      回到上一轮
     *   forward   沿当前分支前进一轮
     *   checkout  跳到指定一轮（路径上的分支指向一并改成它）
     *   switch    换到指定那一支（通常是兄弟分支），HEAD 落到那一支的最新一轮
     */
    moveHead(conversationId, { op, turnId } = {}) {
      if (!HEAD_OPS.has(op)) throw new RepoError(400, `op 只能是 ${[...HEAD_OPS].join(' / ')}`);
      tx(db, () => {
        const row = live(conversationId);
        if (!row) throw new RepoError(404, '会话不存在');
        const head = row.head_turn_id ? q.turn.get(row.head_turn_id, conversationId) : null;
        let target;
        if (op === 'back') {
          if (!head || !head.parent_id) throw new RepoError(409, '已经是第一版了');
          target = q.turn.get(head.parent_id, conversationId);
        } else if (op === 'forward') {
          if (!head || !head.active_child_id) throw new RepoError(409, '已经是这一支的最新一版了');
          target = q.turn.get(head.active_child_id, conversationId);
        } else {
          if (typeof turnId !== 'string' || !turnId) throw new RepoError(400, `${op} 要带 turnId`);
          const picked = q.turn.get(turnId, conversationId);
          if (!picked) throw new RepoError(404, '这一轮不在这个会话里');
          target = op === 'switch' ? tipOf(conversationId, picked) : picked;
        }
        if (!target) throw new RepoError(409, '目标版本不存在');
        alignPath(conversationId, target.id);
        q.setHead.run(target.id, conversationId);
        q.log.run(conversationId, head?.id ?? null, target.id, op, Date.now());
      });
      return this.get(conversationId);
    },

    /** HEAD 移动记录（新的在前） */
    headLog(conversationId, limit = 50) {
      return db
        .prepare('SELECT from_turn_id, to_turn_id, op, created_at FROM head_log WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
        .all(conversationId, Math.max(1, Math.min(500, Number(limit) || 50)))
        .map((r) => ({ from: r.from_turn_id, to: r.to_turn_id, op: r.op, at: r.created_at }));
    },

    rename(id, title) {
      if (typeof title !== 'string' || !title.trim()) throw new RepoError(400, 'title 不能为空');
      return q.rename.run(title.trim().slice(0, TITLE_MAX), Date.now(), id).changes > 0;
    },

    /** 软删除：行还在库里，列表和读取都看不到 */
    remove(id) {
      return q.remove.run(Date.now(), id).changes > 0;
    },

    /** 会话里选中的技能（输入框 chip）。会话还没建出来时返回空 */
    skills(conversationId) {
      return db
        .prepare('SELECT skill_id FROM conversation_skill WHERE conversation_id = ? AND enabled = 1 ORDER BY updated_at')
        .all(conversationId)
        .map((r) => r.skill_id);
    },

    /** 整体替换选中的技能；会话不存在返回 false（第一句话发出去之前选的技能由前端暂存） */
    setSkills(conversationId, ids) {
      if (!Array.isArray(ids) || ids.some((s) => typeof s !== 'string')) throw new RepoError(400, 'skills 必须是字符串数组');
      if (!live(conversationId)) return false;
      const known = new Set(db.prepare('SELECT id FROM skill WHERE enabled = 1').all().map((r) => r.id));
      const bad = ids.filter((s) => !known.has(s));
      if (bad.length) throw new RepoError(400, `没有这个技能：${bad.join('、')}`);
      tx(db, () => {
        const now = Date.now();
        db.prepare('DELETE FROM conversation_skill WHERE conversation_id = ?').run(conversationId);
        const ins = db.prepare('INSERT OR REPLACE INTO conversation_skill (conversation_id, skill_id, enabled, updated_at) VALUES (?, ?, 1, ?)');
        ids.forEach((s, i) => ins.run(conversationId, s, now + i));
      });
      return true;
    },

    /**
     * 导入浏览器 localStorage 里的旧会话（conversations.js 早先的形状）。
     * 按 id 去重：库里已有的整条跳过，所以重复导入是安全的。
     */
    importLegacy(list) {
      if (!Array.isArray(list)) throw new RepoError(400, 'conversations 必须是数组');
      let imported = 0;
      let skipped = 0;
      tx(db, () => {
        for (const c of list) {
          if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || q.get.get(c.id)) {
            skipped++;
            continue;
          }
          const turns = (Array.isArray(c.turns) ? c.turns : []).filter((t) => t && typeof t.user === 'string' && t.user.trim());
          const created = Number(c.createdAt) || Date.now();
          const updated = Number(c.updatedAt) || created;
          q.insertConv.run(c.id, c.title ? String(c.title).slice(0, TITLE_MAX) : titleOf(turns[0]?.user), created, updated);
          // 旧会话是线性的：按顺序串成一条链，HEAD 指最后一轮
          let parentId = null;
          let snapshot = '';
          turns.forEach((t, i) => {
            const state = !t.failure ? 'complete' : t.failure === '已取消' ? 'cancelled' : 'error';
            if (t.raw) snapshot = t.raw;
            const id = insertTurn(c.id, i + 1, { userText: t.user, raw: t.raw, state, summary: t.summary, failure: t.failure, replay: t.opts, createdAt: updated }, updated, { parentId, depth: i + 1, snapshot, refs: {} });
            if (parentId) q.setActiveChild.run(id, parentId);
            parentId = id;
          });
          if (parentId) q.setHead.run(parentId, c.id);
          db.prepare('UPDATE conversation SET turn_count = ? WHERE id = ?').run(turns.length, c.id);
          imported++;
        }
      });
      return { imported, skipped };
    },
  };
}

/** 技能目录（内置 + 以后接入的外部技能） */
export function createSkillRepo(db) {
  const toSkill = (r) => ({
    id: r.id,
    name: r.name,
    version: r.version,
    description: r.description,
    icon: r.icon,
    prompt: r.prompt,
    manifest: parse(r.manifest),
    builtin: !!r.builtin,
    enabled: !!r.enabled,
  });
  return {
    list() {
      return db.prepare('SELECT * FROM skill WHERE enabled = 1 ORDER BY builtin DESC, created_at, id').all().map(toSkill);
    },
  };
}

// ── 模型配置 ────────────────────────────────────────────────────────────────
// 一行一个 OpenAI 兼容端点（接口地址 + Key + 模型名 + 采样参数），可以接多个。
// 「当前用哪个」存在 app_setting 里；把当前那个停用或删掉时，自动落到下一个可用的。
const MODEL_ID_RE = /^m_[A-Za-z0-9]{4,32}$/;
const MODEL_NAME_MAX = 60;
const PROVIDER_MAX = 40;
const ACTIVE_MODEL_KEY = 'activeModelId';

export function createModelRepo(db) {
  const q = {
    list: db.prepare('SELECT * FROM model_config ORDER BY sort, created_at, id'),
    get: db.prepare('SELECT * FROM model_config WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO model_config (id, name, provider, base_url, api_key, model, temperature, thinking, enabled, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    update: db.prepare(
      `UPDATE model_config SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?, temperature = ?,
              thinking = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    ),
    remove: db.prepare('DELETE FROM model_config WHERE id = ?'),
    maxSort: db.prepare('SELECT COALESCE(MAX(sort), -1) AS s FROM model_config'),
    setting: db.prepare('SELECT value FROM app_setting WHERE key = ?'),
    putSetting: db.prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ),
  };

  const toModel = (r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    baseURL: r.base_url,
    apiKey: r.api_key,
    model: r.model,
    temperature: r.temperature,
    thinking: !!r.thinking,
    enabled: !!r.enabled,
    sort: r.sort,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const clampTemp = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(2, Math.round(n * 10) / 10));
  };

  /** 请求体 → 一整行字段；缺的字段沿用 base（更新时传当前行） */
  function normalize(input, base = {}) {
    const name = String(input.name ?? base.name ?? '').trim();
    if (!name) throw new RepoError(400, '模型要有名字（随便起一个，用来在列表里认）');
    return {
      name: name.slice(0, MODEL_NAME_MAX),
      provider: String(input.provider ?? base.provider ?? '').trim().slice(0, PROVIDER_MAX),
      baseURL: String(input.baseURL ?? base.baseURL ?? '').trim().replace(/\/+$/, ''),
      apiKey: String(input.apiKey ?? base.apiKey ?? ''),
      model: String(input.model ?? base.model ?? '').trim(),
      temperature: clampTemp(input.temperature ?? base.temperature, 0.7),
      thinking: (input.thinking ?? base.thinking) ? 1 : 0,
      enabled: (input.enabled ?? base.enabled ?? true) ? 1 : 0,
    };
  }

  /** 库里存的当前模型 id；行没了就当没选 */
  function storedActiveId() {
    const row = q.setting.get(ACTIVE_MODEL_KEY);
    return row && row.value && q.get.get(row.value) ? row.value : null;
  }

  function writeActiveId(id) {
    q.putSetting.run(ACTIVE_MODEL_KEY, id || '', Date.now());
  }

  /** 当前那个不能用时（停用 / 删除）落到的下一个：列表里第一个还开着的 */
  function firstEnabledId(exceptId = null) {
    const row = db.prepare('SELECT id FROM model_config WHERE enabled = 1 AND id != ? ORDER BY sort, created_at, id LIMIT 1').get(exceptId || '');
    return row ? row.id : null;
  }

  function need(id) {
    if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) throw new RepoError(400, '模型 id 形如 m_xxxxxxxx');
    const row = q.get.get(id);
    if (!row) throw new RepoError(404, `模型 ${id} 不存在`);
    return row;
  }

  return {
    list() {
      return q.list.all().map(toModel);
    },

    get(id) {
      return toModel(need(id));
    },

    /** 当前在用哪个（可能为 null：一个都没建、或当前那个被删了） */
    activeId: storedActiveId,

    /** 列表 + 当前，前端一次拿全 */
    snapshot() {
      return { models: this.list(), activeId: storedActiveId() };
    },

    /** 第一个模型建出来就自动设为当前，省得再点一次 */
    create(input) {
      const f = normalize(input);
      return tx(db, () => {
        const now = Date.now();
        const id = shortId('m_');
        q.insert.run(id, f.name, f.provider, f.baseURL, f.apiKey, f.model, f.temperature, f.thinking, f.enabled, q.maxSort.get().s + 1, now, now);
        if (!storedActiveId() && f.enabled) writeActiveId(id);
        return toModel(q.get.get(id));
      });
    },

    update(id, patch) {
      need(id);
      const f = normalize(patch, toModel(q.get.get(id)));
      return tx(db, () => {
        q.update.run(f.name, f.provider, f.baseURL, f.apiKey, f.model, f.temperature, f.thinking, f.enabled, Date.now(), id);
        // 把当前用的那个关掉：自动切到下一个开着的，一个都没有就置空
        if (!f.enabled && storedActiveId() === id) writeActiveId(firstEnabledId(id));
        return toModel(q.get.get(id));
      });
    },

    remove(id) {
      need(id);
      tx(db, () => {
        const wasActive = storedActiveId() === id;
        q.remove.run(id);
        if (wasActive) writeActiveId(firstEnabledId());
      });
      return true;
    },

    /** 只能切到开着的模型；关掉的先打开开关 */
    setActive(id) {
      const row = need(id);
      if (!row.enabled) throw new RepoError(409, '这个模型已经关掉了，先打开开关再用');
      writeActiveId(id);
      return toModel(row);
    },
  };
}

// ── 数据集 ──────────────────────────────────────────────────────────────────
// 内容一律进 blob（按 sha256 去重），版本表只记指针。数据形状：
//   { sheets: [{ name, cells: [[值 | "=公式"]] }] }
const DATASET_RE = /^ds_[A-Za-z0-9]{4,32}$/;
const VERSION_RE = /^dv_[A-Za-z0-9]{4,32}$/;
const AUTHORS = new Set(['import', 'user', 'ai', 'skill']);
const NAME_MAX = 80;
const MAX_CELLS = 2_000_000;

const shortId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export function checkTableData(data) {
  if (!data || !Array.isArray(data.sheets) || !data.sheets.length) throw new RepoError(400, 'data.sheets 至少要有一张表');
  let cells = 0;
  for (const s of data.sheets) {
    if (!s || typeof s.name !== 'string' || !Array.isArray(s.cells)) throw new RepoError(400, '每张表要有 name 和 cells（二维数组）');
    for (const r of s.cells) {
      if (!Array.isArray(r)) throw new RepoError(400, `${s.name} 的 cells 必须是二维数组`);
      cells += r.length;
      for (const v of r) if (v != null && !['string', 'number', 'boolean'].includes(typeof v)) throw new RepoError(400, `${s.name} 里有不是值的单元格`);
    }
  }
  if (cells > MAX_CELLS) throw new RepoError(413, `单元格太多（${cells}），上限 ${MAX_CELLS}`);
}

export function createDatasetRepo(db) {
  const q = {
    putBlob: db.prepare('INSERT OR IGNORE INTO blob (hash, body, size, mime, created_at) VALUES (?, ?, ?, ?, ?)'),
    blob: db.prepare('SELECT * FROM blob WHERE hash = ?'),
    get: db.prepare('SELECT * FROM dataset WHERE id = ? AND deleted_at IS NULL'),
    byConv: db.prepare('SELECT * FROM dataset WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY created_at'),
    insert: db.prepare(
      'INSERT INTO dataset (id, conversation_id, name, source_blob, source_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    touch: db.prepare('UPDATE dataset SET updated_at = ? WHERE id = ?'),
    insertVersion: db.prepare(
      'INSERT INTO dataset_version (id, dataset_id, parent_id, data_blob, author, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    versions: db.prepare('SELECT * FROM dataset_version WHERE dataset_id = ? ORDER BY created_at, rowid'),
    version: db.prepare('SELECT * FROM dataset_version WHERE id = ? AND dataset_id = ?'),
    latest: db.prepare('SELECT * FROM dataset_version WHERE dataset_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    conv: db.prepare('SELECT id FROM conversation WHERE id = ? AND deleted_at IS NULL'),
  };

  const toVersion = (r) => ({ id: r.id, parentId: r.parent_id, author: r.author, note: r.note, createdAt: r.created_at });
  const toDataset = (r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    name: r.name,
    sourceName: r.source_name,
    hasSource: !!r.source_blob,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  function putBlob(body, mime = 'application/octet-stream') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    q.putBlob.run(hash, buf, buf.length, mime, Date.now());
    return hash;
  }

  function putData(data) {
    checkTableData(data);
    return putBlob(Buffer.from(JSON.stringify({ sheets: data.sheets.map((s) => ({ name: s.name, cells: s.cells })) })), 'application/json');
  }

  function need(id) {
    if (typeof id !== 'string' || !DATASET_RE.test(id)) throw new RepoError(400, '数据集 id 形如 ds_xxxx');
    const row = q.get.get(id);
    if (!row) throw new RepoError(404, `数据集 ${id} 不存在`);
    return row;
  }

  function addVersion(datasetId, { parentId = null, data, author, note = null }, now) {
    if (!AUTHORS.has(author)) throw new RepoError(400, `author 只能是 ${[...AUTHORS].join(' / ')}`);
    if (parentId != null && (!VERSION_RE.test(parentId) || !q.version.get(parentId, datasetId))) throw new RepoError(400, `版本 ${parentId} 不属于 ${datasetId}`);
    const id = shortId('dv_');
    q.insertVersion.run(id, datasetId, parentId, putData(data), author, note, now);
    q.touch.run(now, datasetId);
    return toVersion(q.version.get(id, datasetId));
  }

  return {
    putBlob,
    blob(hash) {
      return q.blob.get(hash) || null;
    },

    /** 新建数据集 + 第一个版本。source 是导入的原始文件 { body, mime, name } */
    create({ conversationId = null, name, data, author = 'import', note = null, source = null }) {
      if (typeof name !== 'string' || !name.trim()) throw new RepoError(400, '数据集要有名字');
      if (conversationId != null && !q.conv.get(conversationId)) conversationId = null; // 会话还没建出来：先不挂
      checkTableData(data);
      return tx(db, () => {
        const now = Date.now();
        const id = shortId('ds_');
        const sourceBlob = source ? putBlob(source.body, source.mime) : null;
        q.insert.run(id, conversationId, name.trim().slice(0, NAME_MAX), sourceBlob, source?.name || null, now, now);
        const version = addVersion(id, { data, author, note }, now);
        return { dataset: toDataset(q.get.get(id)), version };
      });
    },

    /** 在 parentId 版本上提交一个新版本（版本是链，不覆盖） */
    commit(datasetId, { parentId = null, data, author = 'user', note = null }) {
      need(datasetId);
      return tx(db, () => addVersion(datasetId, { parentId, data, author, note }, Date.now()));
    },

    get(datasetId) {
      const row = need(datasetId);
      return { ...toDataset(row), versions: q.versions.all(datasetId).map(toVersion) };
    },

    /** 某个版本的内容；不指定版本取最新 */
    read(datasetId, versionId) {
      const row = need(datasetId);
      const v = versionId ? q.version.get(versionId, datasetId) : q.latest.get(datasetId);
      if (!v) throw new RepoError(404, `版本 ${versionId} 不存在`);
      const blob = q.blob.get(v.data_blob);
      return { dataset: toDataset(row), version: toVersion(v), data: JSON.parse(Buffer.from(blob.body).toString('utf8')) };
    },

    /** 原始导入文件 */
    source(datasetId) {
      const row = need(datasetId);
      return row.source_blob ? { name: row.source_name, ...q.blob.get(row.source_blob) } : null;
    },

    listForConversation(conversationId) {
      return q.byConv.all(conversationId).map(toDataset);
    },
  };
}
