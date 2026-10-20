// 技能目录（D1 skill 表）

import { ApiError } from './errors.js';

const parse = (s) => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

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

export async function listSkills(db) {
  const { results } = await db
    .prepare('SELECT * FROM skill WHERE enabled = 1 ORDER BY builtin DESC, created_at, id')
    .all();
  return (results || []).map(toSkill);
}

export async function handleSkills(request, db, path) {
  if (request.method === 'GET' && path === '/skills') {
    return { status: 200, body: { skills: await listSkills(db) } };
  }
  return null;
}

/** 会话里选中的技能 id 列表 */
export async function conversationSkillIds(db, conversationId) {
  const { results } = await db
    .prepare('SELECT skill_id FROM conversation_skill WHERE conversation_id = ? AND enabled = 1 ORDER BY updated_at')
    .bind(conversationId)
    .all();
  return (results || []).map((r) => r.skill_id);
}

/** 整体替换会话技能；会话不存在返回 false */
export async function setConversationSkills(db, conversationId, ids) {
  if (!Array.isArray(ids) || ids.some((s) => typeof s !== 'string')) throw new ApiError(400, 'skills 必须是字符串数组');
  const live = await db.prepare('SELECT id FROM conversation WHERE id = ? AND deleted_at IS NULL').bind(conversationId).first();
  if (!live) return false;
  const { results } = await db.prepare('SELECT id FROM skill WHERE enabled = 1').all();
  const known = new Set((results || []).map((r) => r.id));
  const bad = ids.filter((s) => !known.has(s));
  if (bad.length) throw new ApiError(400, `没有这个技能：${bad.join('、')}`);
  const now = Date.now();
  const stmts = [db.prepare('DELETE FROM conversation_skill WHERE conversation_id = ?').bind(conversationId)];
  ids.forEach((s, i) => {
    stmts.push(
      db
        .prepare(
          'INSERT OR REPLACE INTO conversation_skill (conversation_id, skill_id, enabled, updated_at) VALUES (?, ?, 1, ?)',
        )
        .bind(conversationId, s, now + i),
    );
  });
  await db.batch(stmts);
  return true;
}
