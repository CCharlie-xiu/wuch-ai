// Cloudflare Workers 鉴权：D1 + Web Crypto PBKDF2（Workers 无 node:crypto.scrypt）

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_MIN = 6;
const NAME_MAX = 24;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERS = 100_000;
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;

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

function oauthState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** GitHub OAuth 是否已配置 */
export function githubOauthConfigured(env) {
  return Boolean(env?.GITHUB_CLIENT_ID && env?.GITHUB_SECRET);
}

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

// ── GitHub OAuth ────────────────────────────────────────────────────────────
async function startGithubLogin(db, url, env) {
  if (!githubOauthConfigured(env)) throw new AuthError(503, '站点未配置 GitHub 登录');
  const state = oauthState();
  const next = (url.searchParams.get('next') || '/').slice(0, 200);
  await db
    .prepare('INSERT INTO auth_oauth_state (state, provider, next, created_at) VALUES (?, ?, ?, ?)')
    .bind(state, 'github', next, Date.now())
    .run();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${url.origin}/api/auth/oauth/github/callback`,
    scope: 'read:user user:email',
    state,
  });
  return {
    status: 302,
    body: null,
    location: `https://github.com/login/oauth/authorize?${params}`,
  };
}

const GITHUB_UA = 'wuch-ai';
const githubHeaders = (accessToken) => ({
  Accept: 'application/vnd.github+json',
  'User-Agent': GITHUB_UA,
  'X-GitHub-Api-Version': '2022-11-28',
  ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
});

async function githubCallback(db, url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new AuthError(400, 'GitHub 回调缺参数');

  const row = await db.prepare('SELECT * FROM auth_oauth_state WHERE state = ?').bind(state).first();
  if (!row || row.provider !== 'github') throw new AuthError(400, 'GitHub 授权已过期，请重新发起');
  const now = Date.now();
  if (row.created_at + OAUTH_STATE_TTL_MS < now) throw new AuthError(400, 'GitHub 授权已过期，请重新发起');
  await db.prepare('DELETE FROM auth_oauth_state WHERE state = ?').bind(state).run();

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_SECRET,
      code,
    }),
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    throw new AuthError(502, 'GitHub 授权失败：' + (tokenData.error_description || tokenData.error || 'unknown'));
  }

  const userRes = await fetch('https://api.github.com/user', { headers: githubHeaders(accessToken) });
  if (!userRes.ok) {
    const detail = (await userRes.text().catch(() => '')).slice(0, 120);
    throw new AuthError(502, `GitHub 用户信息获取失败（${userRes.status}）${detail ? '：' + detail : ''}`);
  }
  const gh = await userRes.json();
  const login = String(gh.login || '').trim().toLowerCase();
  if (!login) throw new AuthError(502, 'GitHub 返回的用户名无效');

  let email = '';
  if (gh.email && EMAIL_RE.test(gh.email)) email = normalizeEmail(gh.email);
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers: githubHeaders(accessToken) });
    if (emailsRes.ok) {
      const emails = await emailsRes.json();
      const primary = Array.isArray(emails) && emails.find((e) => e.primary && e.verified);
      if (primary?.email && EMAIL_RE.test(primary.email)) email = normalizeEmail(primary.email);
    }
  }

  const ghName = String(gh.name || login || 'GitHub 用户').trim().slice(0, NAME_MAX);
  const nowMs = Date.now();

  let account = await db
    .prepare('SELECT * FROM account WHERE oauth_provider = ? AND github_login = ?')
    .bind('github', login)
    .first();
  if (account) {
    await db
      .prepare('UPDATE account SET name = ?, email = ?, updated_at = ? WHERE id = ?')
      .bind(ghName, email || account.email, nowMs, account.id)
      .run();
    account = await db.prepare('SELECT * FROM account WHERE id = ?').bind(account.id).first();
  } else {
    let provider = 'github';
    let storeEmail = email;
    if (email) {
      const byEmail = await db.prepare('SELECT * FROM account WHERE email = ?').bind(email).first();
      if (byEmail) {
        provider = 'email';
        storeEmail = email;
        await db
          .prepare('UPDATE account SET oauth_provider = ?, github_login = ?, updated_at = ? WHERE id = ?')
          .bind('github', login, nowMs, byEmail.id)
          .run();
        account = await db.prepare('SELECT * FROM account WHERE id = ?').bind(byEmail.id).first();
      }
    }
    if (!account) {
      const id = accountId();
      const role = await resolveRoleForSignup(db, email, env);
      await db
        .prepare(
          'INSERT INTO account (id, email, name, provider, password_hash, oauth_provider, github_login, role, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
        )
        .bind(id, storeEmail || `${login}@users.noreply.github.com`, ghName, provider, 'github', login, role, nowMs, nowMs)
        .run();
      account = await db.prepare('SELECT * FROM account WHERE id = ?').bind(id).first();
    }
  }

  const token = await issueSession(db, account.id);
  // wuch-ai 前端用 Bearer token（localStorage），结果里带上 token
  await db
    .prepare('INSERT OR REPLACE INTO auth_oauth_result (state, payload, created_at) VALUES (?, ?, ?)')
    .bind(state, JSON.stringify({ account: toAccount(account), token, next: row.next || '/' }), nowMs)
    .run();
  const nextLogin = new URL('/login', url.origin);
  nextLogin.searchParams.set('oauth', 'github');
  nextLogin.searchParams.set('state', state);
  return { status: 302, body: null, location: nextLogin.pathname + nextLogin.search };
}

async function oauthSession(db, url) {
  const state = url.searchParams.get('state');
  if (!state) throw new AuthError(400, '缺少 state');
  const result = await db.prepare('SELECT * FROM auth_oauth_result WHERE state = ?').bind(state).first();
  if (result) {
    const payload = JSON.parse(result.payload);
    await db.prepare('DELETE FROM auth_oauth_result WHERE state = ?').bind(state).run();
    return { status: 200, body: payload };
  }
  const row = await db.prepare('SELECT * FROM auth_oauth_state WHERE state = ?').bind(state).first();
  if (!row) throw new AuthError(404, '授权已失效，请重新发起');
  if (row.created_at + OAUTH_STATE_TTL_MS < Date.now()) {
    await db.prepare('DELETE FROM auth_oauth_state WHERE state = ?').bind(state).run();
    throw new AuthError(404, '授权已过期，请重新发起');
  }
  return { status: 200, body: { pending: true } };
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

  if (path === '/auth/oauth/github/config' && method === 'GET') {
    return { status: 200, body: { enabled: githubOauthConfigured(env) } };
  }
  if (path === '/auth/oauth/github' && method === 'GET') {
    return startGithubLogin(db, new URL(request.url), env);
  }
  if (path === '/auth/oauth/github/callback' && method === 'GET') {
    const cbUrl = new URL(request.url);
    try {
      return await githubCallback(db, cbUrl, env);
    } catch (e) {
      if (e instanceof AuthError) {
        const fail = new URL('/login', cbUrl.origin);
        fail.searchParams.set('oauth', 'github');
        fail.searchParams.set('error', e.message.slice(0, 160));
        return { status: 302, body: null, location: fail.pathname + fail.search };
      }
      throw e;
    }
  }
  if (path === '/auth/oauth/session' && method === 'GET') {
    return oauthSession(db, new URL(request.url));
  }

  if (method === 'POST' && path === '/auth/oauth') {
    throw new AuthError(403, '请使用「使用 GitHub 登录」按钮完成授权');
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
