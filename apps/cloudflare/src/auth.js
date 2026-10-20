// Cloudflare Workers 鉴权：D1 + Web Crypto PBKDF2（Workers 无 node:crypto.scrypt）

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_MIN = 6;
const NAME_MAX = 24;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERS = 100_000;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const accountId = () => 'acc_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const sessionToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function adminEmails(env) {
  const raw = String(env?.ADMIN_EMAIL || '');
  return raw
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
}

export function isAdminEmail(email, env) {
  const mail = normalizeEmail(email);
  return mail && adminEmails(env).includes(mail);
}

export function isAdminAccount(account, env) {
  if (!account) return false;
  if (account.role === 'admin') return true;
  return isAdminEmail(account.email, env);
}

function toAccount(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    provider: row.provider,
    role: row.role || 'user',
    joinedAt: row.created_at,
  };
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hashPassword(password, saltBytes = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERS}$${bytesToHex(saltBytes)}$${bytesToHex(bits)}`;
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith('pbkdf2$')) return false;
  const [, iterStr, saltHex, hashHex] = stored.split('$');
  const iterations = Number(iterStr);
  if (!iterations || !saltHex || !hashHex) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  const actual = bytesToHex(bits);
  if (actual.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

export function bearerToken(request) {
  // /proxy 转发上游时 Authorization 是模型 API Key，会话 token 走 X-OpenUI-Token
  const session = (request.headers.get('X-OpenUI-Token') || '').trim();
  if (session) return session;
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

async function issueSession(db, accountIdValue, now = Date.now()) {
  const token = sessionToken();
  await db
    .prepare('INSERT INTO auth_session (token, account_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)')
    .bind(token, accountIdValue, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

async function requireSession(db, token) {
  if (!token) throw new AuthError(401, '未登录');
  const row = await db
    .prepare(
      `SELECT s.token, s.account_id, s.expires_at, s.revoked_at,
              a.id, a.email, a.name, a.provider, a.role, a.disabled_at, a.created_at
       FROM auth_session s JOIN account a ON a.id = s.account_id
       WHERE s.token = ?`,
    )
    .bind(token)
    .first();
  if (!row) throw new AuthError(401, '登录已失效，请重新登录');
  if (row.revoked_at != null) throw new AuthError(401, '登录已退出');
  if (row.expires_at <= Date.now()) throw new AuthError(401, '登录已过期，请重新登录');
  if (row.disabled_at != null) throw new AuthError(403, '账号已停用');
  return row;
}

export async function requireAccount(request, db) {
  const row = await requireSession(db, bearerToken(request));
  return toAccount(row);
}

async function promoteAdminIfListed(db, id, email, env) {
  if (!isAdminEmail(email, env)) return;
  await db.prepare('UPDATE account SET role = ?, updated_at = ? WHERE id = ?').bind('admin', Date.now(), id).run();
}

async function resolveRoleForSignup(db, email, env) {
  const count = await db.prepare('SELECT COUNT(*) AS n FROM account').first();
  if ((count?.n ?? 0) === 0) return 'admin';
  if (isAdminEmail(email, env)) return 'admin';
  return 'user';
}

export async function handleAuth(request, db, path, env) {
  const method = request.method;
  const json = async () => {
    try {
      return await request.json();
    } catch {
      throw new AuthError(400, '请求体不是合法 JSON');
    }
  };

  if (method === 'POST' && path === '/auth/signup') {
    const body = await json();
    const mail = normalizeEmail(body.email);
    if (!EMAIL_RE.test(mail)) throw new AuthError(400, '邮箱看起来不对');
    if (typeof body.password !== 'string' || body.password.length < PASSWORD_MIN) {
      throw new AuthError(400, `密码至少 ${PASSWORD_MIN} 位`);
    }
    const display = String(body.name || '').trim().slice(0, NAME_MAX);
    if (!display) throw new AuthError(400, '名字不能为空');
    const exists = await db.prepare('SELECT id FROM account WHERE email = ?').bind(mail).first();
    if (exists) throw new AuthError(409, '这个邮箱已经注册过了');
    const now = Date.now();
    const id = accountId();
    const role = await resolveRoleForSignup(db, mail, env);
    await db
      .prepare(
        'INSERT INTO account (id, email, name, provider, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, mail, display, 'email', await hashPassword(body.password), role, now, now)
      .run();
    const account = toAccount({ id, email: mail, name: display, provider: 'email', role, created_at: now });
    return { status: 201, body: { account, token: await issueSession(db, id, now) } };
  }

  if (method === 'POST' && path === '/auth/signin') {
    const body = await json();
    const mail = normalizeEmail(body.email);
    if (!EMAIL_RE.test(mail)) throw new AuthError(400, '邮箱看起来不对');
    if (typeof body.password !== 'string' || !body.password) throw new AuthError(400, '请输入密码');
    const row = await db.prepare('SELECT * FROM account WHERE email = ?').bind(mail).first();
    if (!row || row.provider !== 'email' || !(await verifyPassword(body.password, row.password_hash))) {
      throw new AuthError(401, '邮箱或密码不对');
    }
    if (row.disabled_at != null) throw new AuthError(403, '账号已停用');
    await promoteAdminIfListed(db, row.id, mail, env);
    const fresh = await db.prepare('SELECT * FROM account WHERE id = ?').bind(row.id).first();
    return { status: 200, body: { account: toAccount(fresh), token: await issueSession(db, row.id) } };
  }

  if (method === 'POST' && path === '/auth/oauth') {
    throw new AuthError(403, '演示第三方登录已关闭，请用邮箱注册');
  }

  if (method === 'GET' && path === '/auth/me') {
    const row = await requireSession(db, bearerToken(request));
    return { status: 200, body: { account: toAccount(row) } };
  }

  if (method === 'PATCH' && path === '/auth/me') {
    const row = await requireSession(db, bearerToken(request));
    const body = await json();
    const display = String(body.name || '').trim().slice(0, NAME_MAX);
    if (!display) throw new AuthError(400, '名字不能为空');
    await db.prepare('UPDATE account SET name = ?, updated_at = ? WHERE id = ?').bind(display, Date.now(), row.account_id).run();
    const next = await db.prepare('SELECT * FROM account WHERE id = ?').bind(row.account_id).first();
    return { status: 200, body: { account: toAccount(next) } };
  }

  if (method === 'POST' && path === '/auth/signout') {
    const token = bearerToken(request);
    if (token) {
      await db.prepare('UPDATE auth_session SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL').bind(Date.now(), token).run();
    }
    return { status: 204, body: null };
  }

  throw new AuthError(404, '没有这个接口');
}
