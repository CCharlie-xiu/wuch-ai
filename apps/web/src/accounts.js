// ─────────────────────────────────────────────────────────────────────────────
// 账号：登录 / 注册 / 第三方走 /api/auth/*；本机只缓存账号列表 + 当前 id + token。
// 页面和菜单只调这里的导出，不直接 fetch。
//
// 两个 key 名同时被 apps/web/index.html 头部的门禁脚本引用（那里必须内联、
// 在首屏之前跑，避免闪一下主界面）。改 key 名要一起改。
// ─────────────────────────────────────────────────────────────────────────────

const STORE = 'wuch-ai.accounts';
const CURRENT = 'wuch-ai.current';
const API = '/api/auth';

const readJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const writeJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式写不进去也不该把页面搞挂 */
  }
};

function list() {
  const all = readJSON(STORE, []);
  return Array.isArray(all) ? all : [];
}

function save(all) {
  writeJSON(STORE, all);
}

function setCurrent(id) {
  try {
    localStorage.setItem(CURRENT, id);
  } catch {
    /* 同上 */
  }
}

function currentId() {
  try {
    return localStorage.getItem(CURRENT);
  } catch {
    return null;
  }
}

/** 把服务端账号 + token 写进本机缓存（同 id 覆盖） */
function remember(account, token) {
  const all = list().filter((a) => a.id !== account.id);
  const row = {
    id: account.id,
    name: account.name,
    email: account.email,
    provider: account.provider || 'email',
    joinedAt: account.joinedAt || Date.now(),
    token,
  };
  all.push(row);
  save(all);
  setCurrent(row.id);
  return row;
}

async function api(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败（${res.status}）`);
  }
  return data;
}

/** 当前登录的账号；未登录或没有 token 返回 null */
export function currentAccount() {
  const id = currentId();
  if (!id) return null;
  const hit = list().find((a) => a.id === id);
  if (!hit || !hit.token) return null;
  return hit;
}

export function isSignedIn() {
  return !!currentAccount();
}

export function listAccounts() {
  return list()
    .filter((a) => a && a.token)
    .slice()
    .sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));
}

export function currentToken() {
  return currentAccount()?.token || null;
}

/** 给业务 API 带上登录态；不要覆盖已有 Authorization（例如上游模型 Key） */
export function authHeaders(base = {}) {
  const out = { ...base };
  const token = currentToken();
  if (!token) return out;
  if (!out.Authorization) out.Authorization = `Bearer ${token}`;
  else out['X-OpenUI-Token'] = token;
  return out;
}

/** 走本站 /proxy 转发上游时：Authorization=模型 Key，X-OpenUI-Token=登录态 */
export function proxyAuthHeaders(apiKey, base = {}) {
  const out = { ...base };
  if (apiKey) out.Authorization = `Bearer ${apiKey}`;
  const token = currentToken();
  if (token) out['X-OpenUI-Token'] = token;
  return out;
}

/** 邮箱 + 密码登录 */
export async function signIn({ email, password }) {
  const { account, token } = await api('POST', '/signin', { body: { email, password } });
  return remember(account, token);
}

/** 注册 */
export async function signUp({ email, password, name }) {
  const { account, token } = await api('POST', '/signup', { body: { email, password, name } });
  return remember(account, token);
}

/** 第三方：仍走后端发号 + token */
export async function signInWith(provider) {
  const { account, token } = await api('POST', '/oauth', { body: { provider } });
  return remember(account, token);
}

/** 切换本机已登录过的账号（各账号各自带着自己的 token） */
export function switchTo(id) {
  const hit = list().find((a) => a.id === id && a.token);
  if (!hit) return false;
  setCurrent(id);
  return true;
}

export async function renameCurrent(name) {
  const me = currentAccount();
  if (!me) return null;
  const { account } = await api('PATCH', '/me', { body: { name }, token: me.token });
  const all = list();
  const hit = all.find((a) => a.id === me.id);
  if (hit) {
    hit.name = account.name;
    save(all);
  }
  return hit || remember(account, me.token);
}

export async function signOut() {
  const me = currentAccount();
  if (me?.token) {
    try {
      await api('POST', '/signout', { token: me.token });
    } catch {
      /* 服务端吊销失败也清本地，避免卡在坏 token 上 */
    }
  }
  const id = currentId();
  if (id) {
    save(list().filter((a) => a.id !== id));
  }
  try {
    localStorage.removeItem(CURRENT);
  } catch {
    /* 同上 */
  }
}

/** 只允许站内路径，挡掉 //evil.com 与 javascript: 这类 next */
export function safeNext(value) {
  if (!value || typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
