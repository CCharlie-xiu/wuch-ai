import { ApiError } from './errors.js';

const activeKey = (accountId) => `activeModelId:${accountId}`;
const MODEL_ID_RE = /^m_[A-Za-z0-9]{4,32}$/;
const NAME_MAX = 40;
const PROVIDER_MAX = 40;

const shortId = () => 'm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

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

function normalize(input, base = {}) {
  const name = String(input.name ?? base.name ?? '').trim();
  if (!name) throw new ApiError(400, '模型要有名字（随便起一个，用来在列表里认）');
  return {
    name: name.slice(0, NAME_MAX),
    provider: String(input.provider ?? base.provider ?? '').trim().slice(0, PROVIDER_MAX),
    baseURL: String(input.baseURL ?? base.baseURL ?? '').trim().replace(/\/+$/, ''),
    apiKey: String(input.apiKey ?? base.apiKey ?? ''),
    model: String(input.model ?? base.model ?? '').trim(),
    temperature: clampTemp(input.temperature ?? base.temperature, 0.7),
    thinking: (input.thinking ?? base.thinking) ? 1 : 0,
    enabled: (input.enabled ?? base.enabled ?? true) ? 1 : 0,
  };
}

async function storedActiveId(db, accountId) {
  const key = activeKey(accountId);
  const row = await db.prepare('SELECT value FROM app_setting WHERE key = ?').bind(key).first();
  if (!row?.value) return null;
  const hit = await db
    .prepare('SELECT id FROM model_config WHERE id = ? AND account_id = ?')
    .bind(row.value, accountId)
    .first();
  return hit ? row.value : null;
}

async function writeActiveId(db, accountId, id) {
  await db
    .prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(activeKey(accountId), id || '', Date.now())
    .run();
}

async function firstEnabledId(db, accountId, exceptId = '') {
  const row = await db
    .prepare('SELECT id FROM model_config WHERE enabled = 1 AND account_id = ? AND id != ? ORDER BY sort, created_at, id LIMIT 1')
    .bind(accountId, exceptId || '')
    .first();
  return row ? row.id : null;
}

async function need(db, id, accountId) {
  if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) throw new ApiError(400, '模型 id 形如 m_xxxxxxxx');
  const row = await db.prepare('SELECT * FROM model_config WHERE id = ? AND account_id = ?').bind(id, accountId).first();
  if (!row) throw new ApiError(404, `模型 ${id} 不存在`);
  return row;
}

export async function handleModels(request, db, path, account) {
  const accountId = account.id;
  const method = request.method;
  const json = async () => {
    try {
      return await request.json();
    } catch {
      throw new ApiError(400, '请求体不是合法 JSON');
    }
  };

  if (method === 'GET' && path === '/models') {
    const { results } = await db
      .prepare('SELECT * FROM model_config WHERE account_id = ? ORDER BY sort, created_at, id')
      .bind(accountId)
      .all();
    return { status: 200, body: { models: (results || []).map(toModel), activeId: await storedActiveId(db, accountId) } };
  }

  if (method === 'POST' && path === '/models') {
    const f = normalize(await json());
    const now = Date.now();
    const id = shortId();
    const max = await db
      .prepare('SELECT COALESCE(MAX(sort), -1) AS s FROM model_config WHERE account_id = ?')
      .bind(accountId)
      .first();
    await db
      .prepare(
        `INSERT INTO model_config (id, account_id, name, provider, base_url, api_key, model, temperature, thinking, enabled, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, accountId, f.name, f.provider, f.baseURL, f.apiKey, f.model, f.temperature, f.thinking, f.enabled, (max?.s ?? -1) + 1, now, now)
      .run();
    if (!(await storedActiveId(db, accountId)) && f.enabled) await writeActiveId(db, accountId, id);
    const row = await db.prepare('SELECT * FROM model_config WHERE id = ?').bind(id).first();
    return { status: 201, body: { model: toModel(row) } };
  }

  const m = /^\/models\/([^/]+)(?:\/(activate))?$/.exec(path);
  if (!m) throw new ApiError(404, '没有这个接口');
  const id = decodeURIComponent(m[1]);
  const action = m[2];

  if (method === 'POST' && action === 'activate') {
    const row = await need(db, id, accountId);
    if (!row.enabled) throw new ApiError(409, '这个模型已经关掉了，先打开开关再用');
    await writeActiveId(db, accountId, id);
    const { results } = await db
      .prepare('SELECT * FROM model_config WHERE account_id = ? ORDER BY sort, created_at, id')
      .bind(accountId)
      .all();
    return { status: 200, body: { models: (results || []).map(toModel), activeId: id } };
  }

  if (method === 'PATCH' && !action) {
    const current = toModel(await need(db, id, accountId));
    const f = normalize(await json(), current);
    await db
      .prepare(
        `UPDATE model_config SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?, temperature = ?,
                thinking = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(f.name, f.provider, f.baseURL, f.apiKey, f.model, f.temperature, f.thinking, f.enabled, Date.now(), id)
      .run();
    if (!f.enabled && (await storedActiveId(db, accountId)) === id) await writeActiveId(db, accountId, await firstEnabledId(db, accountId, id));
    const row = await db.prepare('SELECT * FROM model_config WHERE id = ?').bind(id).first();
    return { status: 200, body: { model: toModel(row) } };
  }

  if (method === 'DELETE' && !action) {
    await need(db, id, accountId);
    const wasActive = (await storedActiveId(db, accountId)) === id;
    await db.prepare('DELETE FROM model_config WHERE id = ? AND account_id = ?').bind(id, accountId).run();
    if (wasActive) await writeActiveId(db, accountId, await firstEnabledId(db, accountId));
    return { status: 204, body: null };
  }

  throw new ApiError(404, '没有这个接口');
}
