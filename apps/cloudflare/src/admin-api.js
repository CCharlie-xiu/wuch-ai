import { AuthError, isAdminAccount } from './auth.js';
import { ApiError } from './errors.js';

function toAdminAccount(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    provider: row.provider,
    role: row.role || 'user',
    disabledAt: row.disabled_at ?? null,
    joinedAt: row.created_at,
  };
}

function requireAdmin(account, env) {
  if (!isAdminAccount(account, env)) throw new AuthError(403, '需要管理员权限');
}

export async function handleAdmin(request, db, path, env, account) {
  requireAdmin(account, env);
  const method = request.method;

  if (method === 'GET' && path === '/admin/accounts') {
    const { results } = await db.prepare('SELECT * FROM account ORDER BY created_at, id').all();
    return { status: 200, body: { accounts: (results || []).map(toAdminAccount) } };
  }

  let m = /^\/admin\/accounts\/([^/]+)\/(disable|enable)$/.exec(path);
  if (method === 'POST' && m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    if (id === account.id && action === 'disable') throw new ApiError(409, '不能停用自己的账号');
    const row = await db.prepare('SELECT * FROM account WHERE id = ?').bind(id).first();
    if (!row) throw new ApiError(404, '账号不存在');
    const now = Date.now();
    if (action === 'disable') {
      await db.batch([
        db.prepare('UPDATE account SET disabled_at = ?, updated_at = ? WHERE id = ?').bind(now, now, id),
        db.prepare('UPDATE auth_session SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL').bind(now, id),
      ]);
    } else {
      await db.prepare('UPDATE account SET disabled_at = NULL, updated_at = ? WHERE id = ?').bind(now, id).run();
    }
    const next = await db.prepare('SELECT * FROM account WHERE id = ?').bind(id).first();
    return { status: 200, body: { account: toAdminAccount(next) } };
  }

  throw new ApiError(404, '没有这个接口');
}
