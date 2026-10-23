// ─────────────────────────────────────────────────────────────────────────────
// 登录路由页（/login）：封面 + 登录 / 注册。
//
// 「不能盖一层」这条要求落到实现上就是：登录是独立文档、独立 URL，登录态变化走
// location.assign / replace 做整页跳转。页内的登录 / 注册切换只改 query（mode），
// 用 pushState + popstate，所以浏览器前进后退、刷新、直接粘贴链接都对得上。
//
// 登录 / 注册 / 第三方都走 /api/auth/*（见 src/accounts.js）；本机只缓存 token。
// ─────────────────────────────────────────────────────────────────────────────

import { mountBlobLogos } from './blob-logo.js';
import {
  listAccounts,
  currentAccount,
  signIn,
  signUp,
  signInWith,
  startGithubOAuth,
  pollOAuthSession,
  switchTo,
  safeNext,
} from './accounts.js';

const $ = (s) => document.querySelector(s);

mountBlobLogos();

// ── 顶栏时钟：只为了封面右上角不空，30 秒刷一次够用 ─────────────────────────
function paintClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const box = $('#auth-clock');
  if (box) box.textContent = `${hh}:${mm}`;
}
paintClock();
setInterval(paintClock, 30_000);

// ── 路由参数 ────────────────────────────────────────────────────────────────
const params = () => new URL(location.href).searchParams;
const nextTarget = () => safeNext(params().get('next'));
const isAddMode = () => params().get('add') === '1';

/** 只改 mode 这一个参数，其它（next / add）原样保留 */
function modeOfUrl() {
  return params().get('mode') === 'signup' ? 'signup' : 'signin';
}

let mode = modeOfUrl();
let busy = false;

const LEAD = {
  signin: '用邮箱登录；每位用户的会话与配置互不打通。',
  signup: '用邮箱注册；账号数据只属于你自己。',
};

function applyMode() {
  for (const b of document.querySelectorAll('.auth-tabs [data-mode]')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  const signup = mode === 'signup';
  for (const f of document.querySelectorAll('.auth-field[data-only="signup"]')) f.hidden = !signup;
  $('#auth-lead').textContent = LEAD[mode];
  $('#auth-submit-label').textContent = signup ? '注册并进入' : '登录';
  $('#auth-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  $('#auth-name').required = signup;
  renderRecent();
  document.title = signup ? 'wuch-ai · 注册' : 'wuch-ai · 登录';
}

function goMode(nextMode, { push = true } = {}) {
  if (nextMode === mode) return;
  mode = nextMode;
  if (push) {
    const u = new URL(location.href);
    u.searchParams.set('mode', nextMode);
    history.pushState({ mode: nextMode }, '', u);
  }
  applyMode();
}

for (const b of document.querySelectorAll('.auth-tabs [data-mode]')) {
  b.addEventListener('click', () => goMode(b.dataset.mode));
}
window.addEventListener('popstate', () => {
  mode = modeOfUrl();
  applyMode();
});

// ── 本机已登录过的账号：带有效 token 的可一键切回（不必再输密码）────────────
function renderRecent() {
  const box = $('#auth-recent');
  const list = $('#auth-recent-list');
  if (!box || !list) return;
  const all = listAccounts();
  const me = currentAccount();
  // 只在「登录」态给快捷入口；注册态出现一堆旧账号会让人以为点错了
  if (mode !== 'signin' || !all.length) {
    box.hidden = true;
    list.textContent = '';
    return;
  }
  box.hidden = false;
  list.textContent = '';
  for (const a of all) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'auth-chip';
    btn.classList.toggle('is-current', !!(me && me.id === a.id));
    btn.title = a.email;

    const name = document.createElement('span');
    name.className = 'auth-chip-name';
    name.textContent = a.name;
    const tag = document.createElement('span');
    tag.className = 'auth-chip-tag';
    tag.textContent = a.provider === 'email' ? '邮箱' : a.provider === 'wechat' ? '微信' : 'GitHub';
    btn.append(name, tag);

    btn.addEventListener('click', () => {
      if (me && me.id === a.id) return leave();
      switchTo(a.id);
      leave();
    });
    list.appendChild(btn);
  }
}

// ── 表单 ────────────────────────────────────────────────────────────────────
function showError(msg) {
  const box = $('#auth-err');
  box.textContent = msg;
  box.hidden = !msg;
}

function setBusy(on, label = '') {
  busy = on;
  const btn = $('#auth-submit');
  btn.disabled = on;
  btn.classList.toggle('is-busy', on);
  $('#auth-submit-label').textContent = on && label ? label : mode === 'signup' ? '注册并进入' : '登录';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validate() {
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const name = $('#auth-name').value.trim();
  if (mode === 'signup' && !name) return { error: '给自己起个名字吧（之后在账号菜单里可以改）' };
  if (!EMAIL_RE.test(email)) return { error: '邮箱看起来不对，检查一下 @ 前后' };
  if (password.length < 6) return { error: '密码至少 6 位' };
  return { email, password, name };
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  showError('');
  const out = validate();
  if (out.error) {
    showError(out.error);
    return;
  }
  setBusy(true, mode === 'signup' ? '正在创建…' : '正在登录…');
  try {
    if (mode === 'signup') await signUp(out);
    else await signIn(out);
    leave();
  } catch (err) {
    showError(err.message || '登录失败，稍后再试');
    setBusy(false);
  }
});

// 展示 / 隐藏密码：只切 type，不改值
$('#auth-peek').addEventListener('click', () => {
  const input = $('#auth-password');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('#auth-peek').textContent = showing ? '显示' : '隐藏';
  $('#auth-peek').setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
  input.focus();
});

let githubMode = 'oauth';
async function detectGithubMode() {
  try {
    const r = await fetch('/api/auth/oauth/github/config', { headers: { Accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      githubMode = d && d.enabled ? 'oauth' : 'off';
    }
  } catch {
    githubMode = 'off';
  }
  const btn = $('#auth-github');
  if (btn && githubMode === 'off') btn.hidden = true;
}
await detectGithubMode();

for (const b of document.querySelectorAll('.auth-oauth')) {
  b.addEventListener('click', async () => {
    if (busy) return;
    const provider = b.dataset.provider;
    const label = b.querySelector('span');
    const original = label.textContent;
    if (provider === 'github' && githubMode === 'oauth') {
      busy = true;
      b.disabled = true;
      label.textContent = '正在跳转 GitHub…';
      startGithubOAuth(nextTarget());
      return;
    }
    label.textContent = provider === 'wechat' ? '正在唤起微信…' : '正在跳转 GitHub…';
    b.disabled = true;
    setBusy(true);
    try {
      await signInWith(provider);
      leave();
    } catch (e) {
      showError(e.message || '授权没完成，再试一次');
      label.textContent = original;
      b.disabled = false;
      setBusy(false);
    }
  });
}

/** GitHub 回调：/login?oauth=github&state=… 轮询取 token */
async function resumeGithubOAuth() {
  const q = params();
  if (q.get('oauth') !== 'github') return false;
  const err = q.get('error');
  if (err) {
    showError(err);
    const u = new URL(location.href);
    u.searchParams.delete('oauth');
    u.searchParams.delete('error');
    u.searchParams.delete('state');
    history.replaceState({}, '', u);
    return true;
  }
  const state = q.get('state');
  if (!state) return false;
  busy = true;
  showError('');
  const label = $('#auth-github')?.querySelector('span');
  if (label) label.textContent = '正在完成 GitHub 登录…';
  $('#auth-github') && ($('#auth-github').disabled = true);
  const started = Date.now();
  try {
    while (Date.now() - started < 20_000) {
      const data = await pollOAuthSession(state);
      if (data?.account) {
        const u = new URL(location.href);
        u.searchParams.delete('oauth');
        u.searchParams.delete('state');
        history.replaceState({}, '', u);
        location.assign(safeNext(data.next) || nextTarget());
        return true;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('GitHub 登录超时，请再试一次');
  } catch (e) {
    showError(e.message || 'GitHub 登录失败');
    if (label) label.textContent = '使用 GitHub 登录';
    if ($('#auth-github')) $('#auth-github').disabled = false;
    busy = false;
    const u = new URL(location.href);
    u.searchParams.delete('oauth');
    u.searchParams.delete('state');
    history.replaceState({}, '', u);
    return true;
  }
}

/** 登录成功 / 切号成功：整页跳回，不在这一页里改主应用状态 */
function leave() {
  location.assign(nextTarget());
}

// ── 封面上的入口：滚到登录栏并聚焦邮箱（宽屏其实一屏就看得到）──────────────
function focusAuth() {
  $('#access')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('#auth-email')?.focus({ preventScroll: true }), 260);
}
$('#stage-cta').addEventListener('click', focusAuth);
for (const a of document.querySelectorAll('[data-focus-auth]')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    focusAuth();
  });
}

// ── 首次进入：添加账号的提示 + 已有账号列表 + 邮箱聚焦 ──────────────────────
if (isAddMode()) $('#access-add').hidden = false;
applyMode();

const resumedOauth = await resumeGithubOAuth();

const signedIn = !!currentAccount();
// 未登录时「返回画布」只会被门禁弹回来，索性藏掉，别给死路
if (!signedIn) {
  $('#access-back').hidden = true;
  document.querySelector('.access-sep').hidden = true;
}

// 已登录还停在登录页（比如手输地址）：默认回画布，除非是「添加账号」或正在收 OAuth 回调
if (!resumedOauth && !isAddMode() && signedIn && !params().get('stay')) {
  location.replace(nextTarget());
} else if (!resumedOauth && window.matchMedia('(min-width: 901px)').matches) {
  $('#auth-email').focus({ preventScroll: true });
}

// 输错时给一次轻微提示，不弹提示条抢焦
$('#auth-email').addEventListener('input', () => showError(''));
$('#auth-password').addEventListener('input', () => showError(''));
