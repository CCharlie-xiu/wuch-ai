// ─────────────────────────────────────────────────────────────────────────────
// 设置页「数据库接口列表」：接口目录来自 GET /api/endpoints（服务端路由表），
// 每条可展开调试 —— 填路径参数 / 查询参数 / 请求体，发出去看状态码、耗时和响应。
// 「测试全部」只跑只读接口；会改数据的接口必须手动展开、确认后才发。
// ─────────────────────────────────────────────────────────────────────────────

import { authHeaders } from './accounts.js';

const API = '/api';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

async function send(method, url, body) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers: authHeaders(body != null ? { 'Content-Type': 'application/json' } : {}),
    body: body != null ? body : undefined,
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let pretty = text;
  try {
    pretty = text ? JSON.stringify(JSON.parse(text), null, 2) : '（空响应）';
  } catch (e) {
    /* 不是 JSON 就原样显示 */
  }
  return { status: res.status, ok: res.ok, ms, text: pretty };
}

export function createApiConsole({ root, toast }) {
  let loaded = false;
  let conversationIds = [];

  const head = el('div', 'api-head');
  const status = el('div', 'api-status', '还没检查');
  const testAll = el('button', 'send', '测试全部只读接口');
  testAll.type = 'button';
  const reload = el('button', 'mini', '刷新列表');
  reload.type = 'button';
  head.append(status, el('div', 'grow'), reload, testAll);
  const list = el('div', 'api-list');
  const ids = el('datalist');
  ids.id = 'api-conversation-ids';
  root.append(head, list, ids);

  reload.addEventListener('click', () => load());
  testAll.addEventListener('click', () => runAllReads());

  async function refreshIds() {
    try {
      const r = await fetch(`${API}/conversations?limit=200`, { headers: authHeaders() });
      conversationIds = r.ok ? (await r.json()).conversations : [];
    } catch (e) {
      conversationIds = [];
    }
    ids.textContent = '';
    for (const c of conversationIds) {
      const o = el('option');
      o.value = c.id;
      o.label = c.title;
      ids.appendChild(o);
    }
  }

  async function checkHealth() {
    status.className = 'api-status running';
    status.textContent = '正在检查…';
    try {
      const r = await send('GET', `${API}/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const h = JSON.parse(r.text);
      status.className = 'api-status ok';
      status.textContent = `数据库就绪 · 迁移版本 ${h.schemaVersion ?? '—'} · ${h.file || ''} · ${r.ms}ms`;
      return true;
    } catch (e) {
      status.className = 'api-status bad';
      status.textContent = `连不上数据库接口：${e.message}（确认 bun run dev 已用新代码重启）`;
      return false;
    }
  }

  const cards = [];

  function renderEndpoint(ep) {
    const card = el('div', 'api-card');
    const row = el('button', 'api-row');
    row.type = 'button';
    const method = el('span', `api-method m-${ep.method.toLowerCase()}`, ep.method);
    const path = el('code', 'api-path', '/api' + ep.path);
    const summary = el('span', 'api-summary', ep.summary);
    const badge = el('span', 'api-result');
    row.append(method, path, summary);
    if (ep.writes) row.appendChild(el('span', 'api-writes', '会改数据'));
    row.appendChild(badge);
    card.appendChild(row);

    const body = el('div', 'api-body');
    body.hidden = true;
    const inputs = {};
    const field = (label, name, value, hint, list) => {
      const f = el('label', 'api-field');
      f.appendChild(el('span', null, label));
      const i = el('input');
      i.value = value || '';
      i.spellcheck = false;
      if (hint) i.placeholder = hint;
      if (list) i.setAttribute('list', list);
      f.appendChild(i);
      body.appendChild(f);
      inputs[name] = i;
    };
    for (const p of ep.params) field(`路径参数 :${p}`, 'p:' + p, '', p === 'id' ? '会话 id，可从下拉里选' : '', p === 'id' ? ids.id : null);
    for (const q of ep.query) field(`查询参数 ${q.name}`, 'q:' + q.name, q.example, q.hint);
    let bodyInput = null;
    if (ep.body != null) {
      const f = el('label', 'api-field');
      f.appendChild(el('span', null, '请求体 JSON'));
      bodyInput = el('textarea');
      bodyInput.spellcheck = false;
      bodyInput.rows = Math.min(14, JSON.stringify(ep.body, null, 2).split('\n').length + 1);
      bodyInput.value = JSON.stringify(ep.body, null, 2);
      f.appendChild(bodyInput);
      body.appendChild(f);
    }
    const actions = el('div', 'drawer-actions');
    const go = el('button', ep.writes ? 'mini danger' : 'mini', '发送请求');
    go.type = 'button';
    const urlPreview = el('code', 'api-url');
    actions.append(go, urlPreview);
    body.appendChild(actions);
    const out = el('pre', 'api-out');
    out.hidden = true;
    body.appendChild(out);
    card.appendChild(body);

    function buildUrl() {
      let p = ep.path;
      for (const name of ep.params) p = p.replace(':' + name, encodeURIComponent(inputs['p:' + name].value.trim() || `:${name}`));
      const qs = new URLSearchParams();
      for (const q of ep.query) {
        const v = inputs['q:' + q.name].value.trim();
        if (v) qs.set(q.name, v);
      }
      const s = qs.toString();
      return API + p + (s ? '?' + s : '');
    }
    const updatePreview = () => (urlPreview.textContent = `${ep.method} ${buildUrl()}`);
    for (const i of Object.values(inputs)) i.addEventListener('input', updatePreview);
    updatePreview();

    function showResult(r) {
      badge.className = 'api-result ' + (r.ok ? 'ok' : 'bad');
      badge.textContent = `${r.status} · ${r.ms}ms`;
      out.hidden = false;
      out.className = 'api-out ' + (r.ok ? 'ok' : 'bad');
      out.textContent = r.text;
    }

    async function run({ silent = false } = {}) {
      const missing = ep.params.filter((n) => !inputs['p:' + n].value.trim());
      if (missing.length) {
        if (!silent) toast(`先填路径参数：${missing.join('、')}`);
        return null;
      }
      let payload = null;
      if (bodyInput) {
        try {
          payload = JSON.stringify(JSON.parse(bodyInput.value));
        } catch (e) {
          if (!silent) toast('请求体不是合法 JSON：' + e.message);
          return null;
        }
      }
      if (ep.writes && !silent && !confirm(`${ep.method} ${buildUrl()}\n\n这个接口会改动本地数据库里的数据，确定发送？`)) return null;
      badge.className = 'api-result running';
      badge.textContent = '请求中…';
      try {
        const r = await send(ep.method, buildUrl(), payload);
        showResult(r);
        if (ep.writes) refreshIds();
        return r;
      } catch (e) {
        const r = { status: '—', ok: false, ms: 0, text: '请求没发出去：' + e.message };
        showResult(r);
        return r;
      }
    }

    row.addEventListener('click', () => {
      body.hidden = !body.hidden;
      card.classList.toggle('open', !body.hidden);
    });
    go.addEventListener('click', () => run());

    cards.push({ ep, run, inputs });
    return card;
  }

  async function load() {
    list.textContent = '';
    cards.length = 0;
    const ok = await checkHealth();
    if (!ok) return;
    let endpoints;
    try {
      const r = await fetch(`${API}/endpoints`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      endpoints = (await r.json()).endpoints;
    } catch (e) {
      list.appendChild(el('div', 'settings-empty', '接口目录读不出来：' + e.message));
      return;
    }
    await refreshIds();
    for (const ep of endpoints) list.appendChild(renderEndpoint(ep));
    loaded = true;
  }

  /** 只读接口全跑一遍；带 :id 的用列表里第一个会话 */
  async function runAllReads() {
    if (!loaded) await load();
    if (!loaded) return;
    testAll.disabled = true;
    let pass = 0;
    let fail = 0;
    let skipped = 0;
    for (const c of cards) {
      if (c.ep.writes || c.ep.method !== 'GET') continue;
      if (c.ep.params.includes('id') && !c.inputs['p:id'].value.trim()) {
        if (!conversationIds.length) {
          skipped++;
          continue;
        }
        c.inputs['p:id'].value = conversationIds[0].id;
        c.inputs['p:id'].dispatchEvent(new Event('input'));
      }
      const r = await c.run({ silent: true });
      if (!r) skipped++;
      else if (r.ok) pass++;
      else fail++;
    }
    testAll.disabled = false;
    toast(`只读接口：${pass} 个通过${fail ? `，${fail} 个失败` : ''}${skipped ? `，${skipped} 个跳过（没有会话可用）` : ''}`);
  }

  return {
    /** 切到这个标签时调用：第一次加载，之后只刷新状态 */
    show() {
      if (!loaded) load();
      else checkHealth();
    },
  };
}
