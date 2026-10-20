// ─────────────────────────────────────────────────────────────────────────────
// 设置页：左下角齿轮打开，铺满窗口。左边标签栏切换「模型配置 / 用户喜好配置 /
// 数据库接口列表 / Skill 列表」，以及顶栏那行「当前模型」状态。
//
// 「模型配置」是一个列表：一行一个模型（接口地址 + Key + 模型名），可以重命名、
// 可以接多个、可以关掉。关掉的不出现在输入框的切换列表里。配置存在服务端本地库
// （apps/web/src/models.js 是客户端，后端在 apps/server/src/db.mjs 的 model_config）。
// 用户喜好仍写进 session（session 负责存 localStorage），改完回调 onChange。
// 历史会话归聊天页管，这里只通过 history 回调读数量、清空。
// ─────────────────────────────────────────────────────────────────────────────

import { testConnection, listRemoteModels, diagnoseUpstream, ruleHintsForKind } from './model.js';
import { createApiConsole } from './api-console.js';
import { hostOf, isProxy, modelSub } from './models.js';
import { invalidateMemoryCache } from './memory-client.js';
import { listKb, getKb, archiveKb } from './kb-client.js';
import { authHeaders } from './accounts.js';
import { vt, replayIn } from './motion.js';

const $ = (s) => document.querySelector(s);

const ICON = {
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** 图标要 innerHTML 才解析成 SVG，不能用 el 的 textContent */
const icon = (tag, cls, svg) => {
  const n = el(tag, cls);
  n.innerHTML = svg;
  return n;
};

/**
 * @param {object} o
 * @param {object} o.session
 * @param {object} o.models   models.js 的 store
 * @param {(o?: {apply?: boolean}) => Promise<void>} o.onModelsChange 列表变了之后让聊天页重新同步
 */
export function createSettingsPage({ session, toast, onChange = () => {}, history = null, models, onModelsChange = async () => {} }) {
  const page = $('#settings-page');
  const apiConsole = createApiConsole({ root: $('#api-console'), toast });
  let search = '';
  let expanded = null; // 展开编辑的模型 id（同时只展开一个）
  /**
   * 探测并添加：工具栏打开 / 空列表常驻。
   * open=true 时即使已有模型也会在列表上方画出探测面板。
   */
  const probe = {
    open: false,
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    running: false,
    message: '',
    kind: '',
    snippet: '',
    contentType: '',
    status: 0,
    models: /** @type {{ id: string, name: string, checked: boolean }[]} */ ([]),
    ai: /** @type {null | { diagnosis: string, hints: string[], suggestedBaseURL?: string, suggestedModel?: string }} */ (null),
    aiRunning: false,
  };

  function resetProbeResults() {
    probe.message = '';
    probe.kind = '';
    probe.snippet = '';
    probe.contentType = '';
    probe.status = 0;
    probe.models = [];
    probe.ai = null;
    probe.aiRunning = false;
  }

  function openProbePanel() {
    const snap = models.snapshot();
    const seed = snap.active || snap.enabled[0] || snap.models[0];
    if (seed) {
      if (seed.baseURL) probe.baseURL = seed.baseURL;
      if (seed.apiKey) probe.apiKey = seed.apiKey;
    }
    probe.open = true;
    expanded = null;
    resetProbeResults();
    renderModels();
  }

  function closeProbePanel() {
    probe.open = false;
    probe.running = false;
    resetProbeResults();
    renderModels();
  }

  /** 本地转发地址：官方 API 缺 CORS 时用 */
  function localProxyUrl(upstream) {
    let u = String(upstream || '').trim() || 'https://api.openai.com/v1';
    const marker = '/proxy?url=';
    if (u.includes(marker)) u = u.slice(u.indexOf(marker) + marker.length);
    const origin = location.port === '8788' && location.protocol.startsWith('http') ? location.origin : 'http://127.0.0.1:8788';
    return `${origin}/proxy?url=${u}`;
  }

  /** 已能用的分析模型：优先 session 当前配置，否则第一个开着的 */
  function analyzerConfig() {
    const s = session.state.settings || {};
    if (s.baseURL && s.model) return { baseURL: s.baseURL, apiKey: s.apiKey || '', model: s.model };
    const first = models.snapshot().enabled[0];
    if (first?.baseURL && first?.model) {
      return { baseURL: first.baseURL, apiKey: first.apiKey || '', model: first.model };
    }
    return null;
  }

  /**
   * 切标签。animate: false 给程序化切换用（打开设置时直接落到某个标签）——
   * 那时整页正在做进入过渡，内容区再叠一层动画会糊。
   */
  function switchTab(name, { animate = true } = {}) {
    for (const b of document.querySelectorAll('#settings-tabs [data-stab]')) {
      const on = b.dataset.stab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const p of document.querySelectorAll('.settings-pane')) {
      const on = p.dataset.spane === name;
      p.hidden = !on;
      if (on && animate) replayIn(p, 'pane-in');
    }
    if (name === 'prefs') {
      renderHistoryStat();
      renderMemory();
    }
    if (name === 'db') apiConsole.show();
    if (name === 'model') renderModels();
    if (name === 'tools') renderTools();
    if (name === 'kb') renderKb();
  }

  /** open(true, 'model') 打开并切到某个标签；不给标签就停在上次的位置 */
  function open(show, tab) {
    // 整页铺开走 View Transition：底下的主界面保持不动，设置页自己滑上来
    vt(() => {
      page.hidden = !show;
      if (show) {
        fill();
        if (tab) switchTab(tab, { animate: false });
        else renderHistoryStat();
      }
    });
  }
  $('#open-settings').addEventListener('click', () => open(true));
  $('#close-settings').addEventListener('click', () => open(false));
  for (const b of document.querySelectorAll('#settings-tabs [data-stab]')) b.addEventListener('click', () => switchTab(b.dataset.stab));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !page.hidden) open(false);
  });

  /** 字节数 → 人类可读：不到 10 的保留 1 位小数，免得 1.9MB 被读成 2MB */
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    const units = ['KB', 'MB', 'GB'];
    let x = v / 1024;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i++;
    }
    return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
  }

  async function renderHistoryStat() {
    const stat = $('#history-stat');
    const size = $('#history-size');
    const btn = $('#clear-history');
    if (!history) {
      if (stat) stat.textContent = '—';
      if (size) size.textContent = '—';
      if (btn) btn.disabled = true;
      return;
    }
    if (stat) stat.textContent = '正在读取…';
    try {
      const s = history.stats ? await history.stats() : null;
      if (s) {
        // 库文件含 WAL：删除是软删除，文件不会跟着缩小，所以这里给的是实际占盘
        if (size) size.textContent = fmtBytes(s.dbBytes || s.bytes);
        if (stat) {
          stat.textContent = s.conversations
            ? `${s.conversations} 个会话 · ${s.turns} 轮 · 正文 ${fmtBytes(s.bytes)}`
            : '还没有历史会话';
        }
        btn.disabled = !s.conversations;
        return;
      }
      // 老服务端：只有会话列表可用，条数还会被 list 的 50 条上限截断
      const n = await history.count();
      if (size) size.textContent = '—';
      stat.textContent = n ? `${n} 个会话` : '还没有历史会话';
      btn.disabled = !n;
    } catch (e) {
      stat.textContent = '历史会话读不出来：' + e.message;
      btn.disabled = true;
    }
  }
  $('#history-refresh')?.addEventListener('click', () => renderHistoryStat());
  $('#clear-history').addEventListener('click', async () => {
    if (!history) return;
    if (!confirm('清空全部历史会话？这一步不能撤销。')) return;
    $('#clear-history').disabled = true;
    try {
      await history.clear();
      toast('历史会话已清空');
    } catch (e) {
      toast('清空失败：' + e.message);
    }
    renderHistoryStat();
  });

  function renderStatusLine() {
    const s = session.state.settings;
    if (!s.modelId) {
      $('#status-line').textContent = '未配置模型';
      return;
    }
    // 名字就是模型名时不重复写一遍
    const head = s.modelName && s.modelName !== s.model ? `${s.modelName} · ${s.model}` : s.model;
    $('#status-line').textContent = `${head} · ${hostOf(s.baseURL)}${isProxy(s.baseURL) ? ' · 本地转发' : ''}`;
  }

  function fill() {
    const s = session.state.settings;
    $('#s-onlineImages').checked = !!s.onlineImages;
    $('#s-restoreLast').checked = s.restoreLast !== false;
    $('#s-compress').checked = s.contextCompress !== false;
    $('#s-compressAt').value = String(Math.round((Number(s.compressThreshold) || 0.8) * 100));
    renderCompress();
    renderModels();
    renderTools();
    renderMemory();
  }

  /** 压缩状态：阈值文案 + 这个会话压过几轮、省了多少 */
  function renderCompress() {
    const s = session.state.settings;
    const pct = Math.round((Number(s.compressThreshold) || 0.8) * 100);
    $('#compress-at-label').textContent = `${pct}%`;
    const stat = $('#compress-stat');
    const c = session.state.compress;
    if (!c) {
      const u = session.state.usage;
      const now = u && u.calls && u.contextLimit ? Math.round((u.contextTokens / u.contextLimit) * 100) : null;
      stat.textContent = now == null ? '本会话还没发过请求' : `当前占用 ${now}%，还没压过`;
      return;
    }
    stat.textContent = `已压 ${c.total} 轮 · 最近一次省约 ${Math.round(c.savedChars / 3).toLocaleString()} token`;
  }

  $('#s-compress').addEventListener('change', () => {
    session.setSettings({ contextCompress: $('#s-compress').checked });
    toast($('#s-compress').checked ? '上下文压缩已开启' : '上下文压缩已关闭：历史会原样发送，直到窗口塞满');
    renderCompress();
  });
  $('#s-compressAt').addEventListener('input', () => {
    const pct = Number($('#s-compressAt').value) || 80;
    session.setSettings({ compressThreshold: pct / 100 });
    renderCompress();
  });
  $('#compress-now').addEventListener('click', () => {
    const out = session.compressNow();
    if (!out) {
      toast('没有可压缩的内容：轮次还不够，或压缩已关闭');
      return;
    }
    toast(`已压 ${out.droppedTurns} 轮进摘要（约省 ${Math.round(out.savedChars / 3).toLocaleString()} token），下一轮发送时生效`);
    renderCompress();
  });
  session.on('compress', renderCompress);
  session.on('usage', renderCompress);

  $('#s-onlineImages').addEventListener('change', () => {
    session.setSettings({ onlineImages: $('#s-onlineImages').checked });
    toast('下次取图生效');
  });
  $('#s-restoreLast').addEventListener('change', () => {
    session.setSettings({ restoreLast: $('#s-restoreLast').checked });
    toast('下次打开页面生效');
  });

  // ── 跨会话记忆 ───────────────────────────────────────────────────────────
  let memorySnap = null;
  let memoryItems = [];
  let memoryExcl = new Set();

  async function loadMemory() {
    try {
      const [s, items, excl] = await Promise.all([
        fetch('/api/memory/settings', { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch('/api/memory/items?limit=50', { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch('/api/memory/exclusions', { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      memorySnap = s;
      memoryItems = (items && items.items) || [];
      memoryExcl = new Set(((excl && excl.exclusions) || []).map((e) => e.conversationId));
    } catch (e) {
      memorySnap = null;
      memoryItems = [];
      memoryExcl = new Set();
    }
  }

  async function putMemorySettings(body) {
    const r = await fetch('/api/memory/settings', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    memorySnap = j;
    invalidateMemoryCache();
    return j;
  }

  function bindMemoryControls() {
    const en = $('#s-memoryEnabled');
    const pr = $('#s-memoryProfile');
    const th = $('#s-memoryThreshold');
    const thVal = $('#s-memoryThreshold-val');
    if (!en || !memorySnap) return;
    en.checked = memorySnap.enabled !== false;
    pr.checked = memorySnap.includeInProfile !== false;
    const t = Math.round((memorySnap.confidenceThreshold ?? 0.5) * 100);
    th.value = String(t);
    thVal.textContent = ((t / 100).toFixed(2)).replace(/0+$/, '').replace(/\.$/, '') || '0';
  }

  $('#s-memoryEnabled')?.addEventListener('change', async () => {
    try {
      await putMemorySettings({ enabled: $('#s-memoryEnabled').checked });
      toast($('#s-memoryEnabled').checked ? '已启用记忆' : '已关闭记忆');
    } catch (e) {
      toast('没存上：' + e.message);
      bindMemoryControls();
    }
  });
  $('#s-memoryProfile')?.addEventListener('change', async () => {
    try {
      await putMemorySettings({ includeInProfile: $('#s-memoryProfile').checked });
      toast($('#s-memoryProfile').checked ? '新确认的记忆会进画像' : '不再写入画像');
    } catch (e) {
      toast('没存上：' + e.message);
      bindMemoryControls();
    }
  });
  let thTimer = null;
  $('#s-memoryThreshold')?.addEventListener('input', () => {
    const v = Number($('#s-memoryThreshold').value) / 100;
    $('#s-memoryThreshold-val').textContent = v.toFixed(2);
    clearTimeout(thTimer);
    thTimer = setTimeout(async () => {
      try {
        await putMemorySettings({ confidenceThreshold: v });
      } catch (e) {
        toast('门槛没存上：' + e.message);
      }
    }, 400);
  });
  $('#memory-refresh')?.addEventListener('click', () => renderMemory());
  $('#clear-profile')?.addEventListener('click', async () => {
    if (!confirm('清空全部画像标签？记忆条目还在，只清画像。')) return;
    try {
      const r = await fetch('/api/memory/profile', { method: 'DELETE', headers: authHeaders() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      invalidateMemoryCache();
      toast(`已清空 ${j.cleared || 0} 个画像标签`);
    } catch (e) {
      toast('清空失败：' + e.message);
    }
  });

  function memoryRow(item) {
    const row = el('div', 'memory-row');
    const main = el('div', 'mem-main');
    const head = el('div');
    head.appendChild(el('span', 'mem-type', item.type));
    head.appendChild(el('span', 'mem-conf', `${item.status} · ${(item.confidence * 100) | 0}% · 证据 ${item.evidenceCount}`));
    main.appendChild(head);
    main.appendChild(el('div', null, item.statement));
    row.appendChild(main);

    const actions = el('div', 'mem-actions');
    if (item.status !== 'confirmed' && item.status !== 'rejected') {
      const ok = el('button', 'set-btn tiny', '确认');
      ok.type = 'button';
      ok.addEventListener('click', async () => {
        try {
          await fetch(`/api/memory/items/${encodeURIComponent(item.id)}/confirm`, { method: 'POST', headers: authHeaders() });
          invalidateMemoryCache();
          toast('已确认');
          renderMemory();
        } catch (e) {
          toast('失败：' + e.message);
        }
      });
      actions.appendChild(ok);
    }
    if (item.status !== 'rejected') {
      const no = el('button', 'mini danger', '否定');
      no.type = 'button';
      no.addEventListener('click', async () => {
        try {
          await fetch(`/api/memory/items/${encodeURIComponent(item.id)}/reject`, { method: 'POST', headers: authHeaders() });
          invalidateMemoryCache();
          toast('已否定');
          renderMemory();
        } catch (e) {
          toast('失败：' + e.message);
        }
      });
      actions.appendChild(no);
    }
    row.appendChild(actions);
    return row;
  }

  async function renderMemoryExcl() {
    const box = $('#memory-excl');
    if (!box) return;
    box.textContent = '';
    let conversations = [];
    try {
      if (history && history.list) conversations = await history.list();
      else {
        const r = await fetch('/api/conversations?limit=30', { headers: authHeaders() });
        conversations = r.ok ? ((await r.json()).conversations || []) : [];
      }
    } catch (e) {
      box.appendChild(el('em', null, '读不到会话列表'));
      return;
    }
    if (!conversations.length) {
      box.appendChild(el('em', null, '还没有会话'));
      return;
    }
    for (const c of conversations.slice(0, 30)) {
      const lab = el('label', 'chk');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = memoryExcl.has(c.id);
      cb.addEventListener('change', async () => {
        try {
          const r = await fetch(`/api/memory/exclusions/${encodeURIComponent(c.id)}`, {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ excluded: cb.checked }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          memoryExcl = new Set((j.exclusions || []).map((e) => e.conversationId));
          invalidateMemoryCache();
          toast(cb.checked ? `已排除「${c.title || c.id}」` : `「${c.title || c.id}」重新计入记忆`);
          renderMemory();
        } catch (e) {
          cb.checked = !cb.checked;
          toast('没改成：' + e.message);
        }
      });
      lab.append(cb, el('span', null, c.title || c.id));
      box.appendChild(lab);
    }
  }

  async function renderMemory() {
    const list = $('#memory-list');
    const stat = $('#memory-stat');
    if (!list) return;
    await loadMemory();
    bindMemoryControls();
    list.textContent = '';
    if (!memorySnap) {
      if (stat) stat.textContent = '读不到记忆设置（服务端要在跑）';
      list.appendChild(el('em', null, '把 bun run dev 跑起来再打开'));
      return;
    }
    if (stat) stat.textContent = memoryItems.length ? `${memoryItems.length} 条（最多显示 50）` : '还没有记忆条目';
    if (!memoryItems.length) {
      list.appendChild(el('em', null, '聊几句带偏好的话（例如「我喜欢暗色主题」）再刷新'));
    } else {
      for (const item of memoryItems) list.appendChild(memoryRow(item));
    }
    await renderMemoryExcl();
  }

  // ── 模型列表 ─────────────────────────────────────────────────────────────
  const listBox = $('#model-list');
  const searchBox = $('#model-search');

  searchBox.addEventListener('input', () => {
    search = searchBox.value;
    renderModels();
  });

  $('#model-probe-open')?.addEventListener('click', () => openProbePanel());

  $('#model-add').addEventListener('click', async () => {
    probe.open = false;
    try {
      const n = models.snapshot().models.length;
      const seed = models.snapshot().active || models.snapshot().enabled[0];
      const m = await models.create({
        name: n ? `新模型 ${n + 1}` : '默认模型',
        provider: seed?.provider || '',
        baseURL: seed?.baseURL || 'https://api.openai.com/v1',
        apiKey: seed?.apiKey || '',
        model: seed?.model || 'gpt-4o-mini',
      });
      expanded = m.id;
      search = '';
      searchBox.value = '';
      await afterChange('已手动新增「' + m.name + '」，可改地址或点「探测列表」选模型');
    } catch (e) {
      toast('新增失败：' + e.message);
    }
  });

  /** 改完列表 → 让聊天页重新同步当前模型 → 重画列表和状态行 */
  async function afterChange(msg) {
    await onModelsChange();
    renderModels();
    renderStatusLine();
    onChange(session.state.settings);
    if (msg) toast(msg);
  }

  function field(label, node, hint) {
    const f = el('label', 'fld');
    f.appendChild(el('span', null, label));
    f.appendChild(node);
    if (hint) f.appendChild(el('em', null, hint));
    return f;
  }

  /** 一行模型：左边名字 + 一行说明，右边「当前」标记、启用开关、删除 */
  function renderRow(m, activeId) {
    const row = el('div', 'model-row');
    const open = expanded === m.id;
    row.classList.toggle('open', open);
    if (m.id === activeId) row.classList.add('active');
    if (!m.enabled) row.classList.add('off');

    const head = el('div', 'model-row-head');
    const main = el('button', 'model-main');
    main.type = 'button';
    main.setAttribute('aria-expanded', String(open));
    main.appendChild(el('span', 'model-name', m.name));
    main.appendChild(el('span', 'model-sub', modelSub(m)));
    head.appendChild(main);

    if (m.id === activeId) head.appendChild(el('span', 'model-now', '当前'));

    const sw = el('label', 'switch');
    sw.title = m.enabled ? '关掉：不再出现在输入框的切换列表里' : '打开：可以在输入框里选它';
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = m.enabled;
    cb.addEventListener('change', async () => {
      try {
        await models.update(m.id, { enabled: cb.checked });
        await afterChange(cb.checked ? `已启用「${m.name}」` : `已关闭「${m.name}」，输入框里不再出现`);
      } catch (e) {
        cb.checked = m.enabled;
        toast('改不动：' + e.message);
      }
    });
    sw.append(cb, el('i'));
    head.appendChild(sw);

    const del = icon('button', 'icon-btn small model-del', ICON.trash);
    del.type = 'button';
    del.title = '删除这个模型配置';
    del.setAttribute('aria-label', `删除 ${m.name}`);
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除「${m.name}」？这一步不能撤销。`)) return;
      try {
        if (expanded === m.id) expanded = null;
        await models.remove(m.id);
        await afterChange(`已删除「${m.name}」`);
      } catch (err) {
        toast('删除失败：' + err.message);
      }
    });
    head.appendChild(del);
    row.appendChild(head);

    main.addEventListener('click', () => {
      expanded = open ? null : m.id;
      renderModels();
    });

    if (open) row.appendChild(renderForm(m, activeId));
    return row;
  }

  /** 展开的编辑表单：改一个字就存一次，不用点保存 */
  function renderForm(m, activeId) {
    const form = el('div', 'model-form');

    const name = el('input');
    name.value = m.name;
    name.spellcheck = false;
    form.appendChild(field('名称', name, '列表里显示的就是它，随便起'));

    const provider = el('input');
    provider.value = m.provider;
    provider.spellcheck = false;
    provider.placeholder = 'DeepSeek / OpenAI / 本地…';
    form.appendChild(field('分组', provider, '输入框的切换列表按分组归类，留空算「其他」'));

    const baseURL = el('input');
    baseURL.value = m.baseURL;
    baseURL.spellcheck = false;
    baseURL.placeholder = 'https://api.openai.com/v1';
    const proxy = el('button', 'set-btn tiny', '改成本地转发地址');
    proxy.type = 'button';
    const urlWrap = el('div', 'fld-stack');
    urlWrap.append(baseURL, proxy);
    form.appendChild(field('接口地址', urlWrap, '官方 API 不返回 CORS 头，浏览器直连会被拦 —— 走本地转发要先把 bun run dev 跑起来'));

    const key = el('input');
    key.type = 'password';
    key.value = m.apiKey;
    key.spellcheck = false;
    key.autocomplete = 'off';
    key.placeholder = 'sk-…';
    const peek = el('button', 'set-btn tiny', '显示');
    peek.type = 'button';
    const keyRow = el('div', 'key-row');
    keyRow.append(key, peek);
    form.appendChild(field('API Key', keyRow, '存在本地库（SQLite）里，不会发往上面地址以外的任何地方'));

    const model = el('input');
    model.value = m.model;
    model.spellcheck = false;
    model.placeholder = 'gpt-4o-mini';
    const probeListBtn = el('button', 'set-btn tiny', '探测列表');
    probeListBtn.type = 'button';
    probeListBtn.title = '用当前地址和 Key 请求 /models，点选一个填进模型名';
    const modelRow = el('div', 'key-row');
    modelRow.append(model, probeListBtn);
    const modelStack = el('div', 'fld-stack');
    const inlinePick = el('div', 'model-inline-pick');
    inlinePick.hidden = true;
    modelStack.append(modelRow, inlinePick);
    form.appendChild(field('模型', modelStack, '不知道叫什么就点「探测列表」；失败且已有可用模型时会尝试 AI 纠错'));

    const temp = el('input');
    temp.type = 'range';
    temp.min = '0';
    temp.max = '2';
    temp.step = '0.1';
    temp.value = m.temperature;
    const tempVal = el('b', null, Number(m.temperature).toFixed(1));
    const tempLabel = el('span', null, '温度 ');
    tempLabel.appendChild(tempVal);
    const tempFld = el('label', 'fld');
    tempFld.append(tempLabel, temp);
    form.appendChild(tempFld);

    const thinking = el('label', 'chk');
    const thinkBox = el('input');
    thinkBox.type = 'checkbox';
    thinkBox.checked = !!m.thinking;
    thinking.append(thinkBox, el('span', null, '允许模型先思考（DeepSeek 默认开启；开着要等思考完界面才开始出现）'));
    form.appendChild(thinking);

    /** 单个字段改完就存，失败就把界面上的值退回去 */
    async function save(patch, input, revert) {
      try {
        await models.update(m.id, patch);
        await afterChange();
      } catch (e) {
        if (revert != null) input.value = revert;
        toast('没存上：' + e.message);
      }
    }

    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (!v) return save({ name: m.name }, name, m.name);
      save({ name: v });
    });
    provider.addEventListener('change', () => save({ provider: provider.value }));
    baseURL.addEventListener('change', () => save({ baseURL: baseURL.value }));
    key.addEventListener('change', () => save({ apiKey: key.value }));
    model.addEventListener('change', () => save({ model: model.value }));
    temp.addEventListener('input', () => (tempVal.textContent = Number(temp.value).toFixed(1)));
    temp.addEventListener('change', () => save({ temperature: Number(temp.value) }));
    thinkBox.addEventListener('change', () => save({ thinking: thinkBox.checked }));

    peek.addEventListener('click', () => {
      const show = key.type === 'password';
      key.type = show ? 'text' : 'password';
      peek.textContent = show ? '隐藏' : '显示';
    });
    proxy.addEventListener('click', () => {
      const next = localProxyUrl(baseURL.value);
      baseURL.value = next;
      save({ baseURL: next });
      toast('已改为本地转发地址（先确保 bun run dev 在跑）');
    });

    const actions = el('div', 'drawer-actions');
    const test = el('button', 'set-btn primary', '测试连接');
    test.type = 'button';
    const out = el('div', 'test-result');
    const diag = el('div', 'model-diagnose');
    diag.hidden = true;

    /** 规则提示 + 可选 AI 纠错条 */
    function showDiagnose(failed, ai = null) {
      diag.hidden = false;
      diag.textContent = '';
      diag.className = 'model-diagnose' + (ai ? ' has-ai' : '');

      const title = el('div', 'model-diagnose-title', ai ? 'AI 分析' : '可能原因');
      diag.appendChild(title);
      if (ai?.diagnosis) diag.appendChild(el('p', 'model-diagnose-body', ai.diagnosis));

      const hints = (ai?.hints?.length ? ai.hints : failed.hints || ruleHintsForKind(failed.kind)) || [];
      if (hints.length) {
        const ul = el('ul', 'model-diagnose-hints');
        for (const h of hints) ul.appendChild(el('li', null, h));
        diag.appendChild(ul);
      }

      const canApply = !!(ai && (ai.suggestedBaseURL || ai.suggestedModel));
      if (canApply) {
        const apply = el('button', 'set-btn tiny', '应用建议');
        apply.type = 'button';
        apply.addEventListener('click', async () => {
          const patch = {};
          if (ai.suggestedBaseURL) {
            baseURL.value = ai.suggestedBaseURL;
            patch.baseURL = ai.suggestedBaseURL;
          }
          if (ai.suggestedModel) {
            model.value = ai.suggestedModel;
            patch.model = ai.suggestedModel;
          }
          try {
            await models.update(m.id, patch);
            await afterChange('已应用建议，可以再测一次连接');
          } catch (e) {
            toast('没存上：' + e.message);
          }
        });
        diag.appendChild(apply);
      }
    }

    async function maybeAiDiagnose(failed, statusEl) {
      const needAi = failed.kind === 'html' || failed.kind === 'shape';
      const analyzer = needAi ? analyzerConfig() : null;
      if (!analyzer) {
        showDiagnose(failed);
        return;
      }
      showDiagnose(failed);
      if (statusEl) statusEl.textContent = (statusEl.textContent || '') + ' · 正在用当前模型分析…';
      try {
        const ai = await diagnoseUpstream({
          analyzer,
          failed,
          userBaseURL: baseURL.value.trim(),
          userModel: model.value.trim(),
        });
        if (statusEl) statusEl.textContent = statusEl.textContent.replace(/\s· 正在用当前模型分析…$/, '');
        showDiagnose(failed, ai);
      } catch (e) {
        if (statusEl) {
          statusEl.textContent =
            statusEl.textContent.replace(/\s· 正在用当前模型分析…$/, '') + '（AI 分析未完成：' + e.message + '）';
        }
      }
    }

    probeListBtn.addEventListener('click', async () => {
      inlinePick.hidden = false;
      inlinePick.textContent = '';
      inlinePick.appendChild(el('div', 'test-result running', '正在探测 /models…'));
      diag.hidden = true;
      const result = await listRemoteModels({
        baseURL: baseURL.value.trim(),
        apiKey: key.value,
      });
      inlinePick.textContent = '';
      if (result.kind !== 'ok' || !result.models?.length) {
        inlinePick.appendChild(
          el('div', 'test-result bad', result.message || '探测失败'),
        );
        await maybeAiDiagnose(result, null);
        return;
      }
      const head = el('div', 'model-probe-pick-head');
      head.appendChild(el('span', null, `选一个填入（${result.models.length}）`));
      inlinePick.appendChild(head);
      const pick = el('div', 'model-probe-pick model-probe-pick-compact');
      for (const row of result.models.slice(0, 80)) {
        // 列表展示 id（写入「模型」的就是它）；有不同显示名时附一行说明，绝不改「名称」
        const btn = el('button', 'model-probe-pick-btn');
        btn.type = 'button';
        btn.appendChild(el('span', 'model-probe-pick-id', row.id));
        if (row.name && row.name !== row.id) {
          btn.appendChild(el('span', 'model-probe-pick-name', row.name));
        }
        btn.addEventListener('click', async () => {
          model.value = row.id;
          try {
            await models.update(m.id, { model: row.id });
            await afterChange(`模型已改为「${row.id}」`);
          } catch (e) {
            toast('没存上：' + e.message);
          }
        });
        pick.appendChild(btn);
      }
      inlinePick.appendChild(pick);
    });

    test.addEventListener('click', async () => {
      out.className = 'test-result running';
      out.textContent = '正在请求…';
      diag.hidden = true;
      diag.textContent = '';
      const result = await testConnection({
        baseURL: baseURL.value.trim(),
        apiKey: key.value,
        model: model.value.trim(),
      });
      if (result.kind === 'ok') {
        out.className = 'test-result ok';
        out.textContent = result.message;
        return;
      }
      out.className = 'test-result bad';
      out.textContent = '失败：' + result.message;
      await maybeAiDiagnose(result, out);
    });
    actions.appendChild(test);
    if (m.id !== activeId) {
      const use = el('button', 'set-btn', '设为当前');
      use.type = 'button';
      use.addEventListener('click', async () => {
        try {
          await models.activate(m.id);
          await afterChange(`已切到「${m.name}」`);
        } catch (e) {
          toast('切不过去：' + e.message);
        }
      });
      actions.appendChild(use);
    }
    form.appendChild(actions);
    form.appendChild(out);
    form.appendChild(diag);
    return form;
  }

  // ── 工具（联网搜索 / 读取网页）──────────────────────────────────────────
  const toolBox = $('#tool-list');
  const toolKeyBox = $('#tool-key');
  let toolSnap = null;

  async function loadTools() {
    try {
      const r = await fetch('/api/tools', { headers: authHeaders() });
      toolSnap = r.ok ? await r.json() : null;
    } catch (e) {
      toolSnap = null;
    }
  }

  async function putTools(body) {
    const r = await fetch('/api/tools', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (j.tools) toolSnap = j;
    return j;
  }

  /** 一行工具：名字 + 说明、授权方式、开关 */
  function toolRow(t) {
    const row = el('div', 'model-row');
    if (!t.enabled) row.classList.add('off');
    const head = el('div', 'model-row-head');

    const main = el('div', 'model-main');
    main.appendChild(el('span', 'model-name', t.name));
    // 工具说明是中文句子，走等宽字会糊；两行截断，完整文案放 title
    const sub = el('span', 'tool-sub', t.summary || '');
    sub.title = t.summary || '';
    main.appendChild(sub);
    head.appendChild(main);

    const sel = el('select', 'tool-approval');
    for (const [v, label] of [['auto', '自动'], ['ask', '每次询问']]) {
      const o = el('option', null, label);
      o.value = v;
      sel.appendChild(o);
    }
    sel.value = t.approval === 'ask' ? 'ask' : 'auto';
    sel.disabled = !t.enabled;
    sel.title = '自动：模型要用就直接调；每次询问：调用前先弹一次确认';
    sel.addEventListener('change', async () => {
      try {
        await putTools({ tools: { [t.id]: { approval: sel.value } } });
        toast(`「${t.name}」改成${sel.value === 'ask' ? '每次询问' : '自动'}`);
      } catch (e) {
        sel.value = t.approval;
        toast('没存上：' + e.message);
      }
    });
    head.appendChild(sel);

    const sw = el('label', 'switch');
    sw.title = t.enabled ? '关掉：不再出现在模型的工具列表里' : '打开：模型可以用它';
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = t.enabled;
    cb.addEventListener('change', async () => {
      try {
        await putTools({ tools: { [t.id]: { enabled: cb.checked } } });
        t.enabled = cb.checked;
        sel.disabled = !cb.checked;
        row.classList.toggle('off', !cb.checked);
        toast(cb.checked ? `已启用「${t.name}」` : `已关闭「${t.name}」`);
      } catch (e) {
        cb.checked = t.enabled;
        toast('改不动：' + e.message);
      }
    });
    sw.append(cb, el('i'));
    head.appendChild(sw);

    row.appendChild(head);
    return row;
  }

  function renderToolKey() {
    if (!toolKeyBox) return;
    toolKeyBox.textContent = '';
    const input = el('input', 'set-input');
    input.type = 'password';
    input.value = toolSnap.tavilyKey || '';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'tvly-…';
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          await putTools({ tavilyKey: input.value.trim() });
          paintState();
        } catch (e) {
          toast('Key 没存上：' + e.message);
        }
      }, 500);
    });

    const peek = el('button', 'set-btn', '显示');
    peek.type = 'button';
    peek.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      peek.textContent = show ? '隐藏' : '显示';
    });

    const state = el('div', 'set-desc');
    const paintState = () => {
      state.textContent = input.value.trim()
        ? '已存进本地库，只发往 Tavily。'
        : '还没填：搜索走免费通道，够用但不保证稳定。';
    };
    paintState();

    // 和用户喜好页同一套「分组卡 + 设置行」，不要再出现第三种表单长相
    const sec = el('section', 'set-section');
    const head = el('div', 'set-sec-head');
    head.appendChild(el('h3', null, '搜索服务'));
    sec.appendChild(head);
    const card = el('div', 'set-card');
    const row = el('div', 'set-row stack');
    const main = el('div', 'set-row-main');
    main.appendChild(el('div', 'set-label', 'Tavily Key'));
    const keyRow = el('div', 'key-row');
    keyRow.append(input, peek);
    main.appendChild(keyRow);
    main.appendChild(state);
    row.appendChild(main);
    card.appendChild(row);
    sec.appendChild(card);
    toolKeyBox.appendChild(sec);
  }

  async function renderTools() {
    if (!toolBox) return;
    await loadTools();
    toolBox.textContent = '';
    if (!toolSnap || !toolSnap.tools) {
      const empty = el('div', 'settings-empty');
      empty.append(el('b', null, '读不到工具设置'), el('span', null, '把 bun run dev 跑起来再打开这一页（工具目录由服务端提供）。'));
      toolBox.appendChild(empty);
      return;
    }
    for (const t of Object.values(toolSnap.tools)) toolBox.appendChild(toolRow(t));
    renderToolKey();
  }

  // ── 知识库（AOCI）：只读展示。上传只发生在对话里，这里没有上传入口 ────────
  const kbBox = $('#kb-list');
  let kbSearch = '';
  let kbExpanded = null; // 展开看正文的条目 id（同时只展开一个）

  $('#kb-search')?.addEventListener('input', (e) => {
    kbSearch = e.target.value;
    renderKb();
  });
  $('#kb-showArchived')?.addEventListener('change', () => renderKb());
  $('#kb-refresh')?.addEventListener('click', () => renderKb());

  /** 展开的那一条：类型 / 成熟度 / 证据 + 蒸馏正文（正文单独拉一次） */
  function kbDetail(it) {
    const box = el('div', 'kb-detail');
    box.appendChild(
      el('div', 'kb-meta', `类型 ${it.kind} · 成熟度 ${it.maturity} · 置信度 ${(it.confidence * 100) | 0}% · 命中 ${it.hitCount} 次 · 证据 ${it.evidenceCount} 条`),
    );
    const body = el('pre', 'kb-body', '正在读取正文…');
    const ev = el('div', 'kb-evidence');
    box.append(body, ev);
    getKb(it.id)
      .then((out) => {
        body.textContent = out.body || '（没有正文）';
        const list = out.evidence || [];
        ev.textContent = list.length
          ? '来源：' + list.map((e) => [e.fileName, e.conversationId, e.turnId].filter(Boolean).join(' / ') || '对话').join('；')
          : '来源：没有记录';
      })
      .catch((e) => {
        body.textContent = '读不出来：' + e.message;
      });
    return box;
  }

  function kbRow(it) {
    const row = el('div', 'kb-row');
    const open = kbExpanded === it.id;
    row.classList.toggle('open', open);
    if (it.status === 'archived') row.classList.add('off');

    const head = el('div', 'kb-row-head');
    const main = el('button', 'kb-main');
    main.type = 'button';
    main.setAttribute('aria-expanded', String(open));
    main.appendChild(el('span', 'kb-name', it.name));
    main.appendChild(el('span', 'kb-sub', it.summary || '（没写一句话）'));
    head.appendChild(main);
    if (it.tag) head.appendChild(el('span', 'kb-tag', it.tag));

    // 归档是次要动作：中性小按钮，不跟「点开看正文」抢注意力；宽度固定，文字不折行
    const archived = it.status === 'archived';
    const arch = el('button', 'kb-arch', archived ? '已归档' : '归档');
    arch.type = 'button';
    arch.disabled = archived;
    arch.title = archived
      ? '已经归档了：勾上「含已归档」才看得到它'
      : '归档后模型就看不到它了；数据还在，勾「含已归档」能看回来';
    arch.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`归档「${it.name}」？归档后模型看不到了（不删数据）。`)) return;
      try {
        await archiveKb(it.id);
        if (kbExpanded === it.id) kbExpanded = null;
        toast('已归档');
        renderKb();
      } catch (err) {
        toast('归档失败：' + err.message);
      }
    });
    head.appendChild(arch);
    row.appendChild(head);

    main.addEventListener('click', () => {
      kbExpanded = open ? null : it.id;
      renderKb();
    });

    if (open) row.appendChild(kbDetail(it));
    return row;
  }

  async function renderKb() {
    if (!kbBox) return;
    const stat = $('#kb-stat');
    kbBox.textContent = '';
    kbBox.classList.remove('is-empty'); // 空态自己不带卡片外框，不然是「卡里套卡」
    let items = [];
    try {
      items = await listKb({ limit: 200, status: $('#kb-showArchived')?.checked ? 'all' : 'active' });
    } catch (e) {
      if (stat) stat.textContent = '读不到知识库（服务端要在跑）';
      kbBox.classList.add('is-empty');
      kbBox.appendChild(el('em', null, '把 bun run dev 跑起来再打开这一页'));
      return;
    }
    const q = kbSearch.trim().toLowerCase();
    const hit = q ? items.filter((it) => `${it.name} ${it.summary} ${it.tag}`.toLowerCase().includes(q)) : items;
    if (stat) stat.textContent = items.length ? `${items.length} 条${q ? ` · 命中 ${hit.length}` : ''}` : '还没有条目';

    if (!items.length) {
      kbBox.classList.add('is-empty');
      const empty = el('div', 'settings-empty');
      empty.append(el('b', null, '知识库是空的'), el('span', null, '在对话里上传文件、让 AI 阅读后蒸馏入库 —— 这里不能直接上传。'));
      kbBox.appendChild(empty);
      return;
    }
    if (!hit.length) {
      kbBox.classList.add('is-empty');
      kbBox.appendChild(el('div', 'mp-empty', '没有匹配的条目'));
      return;
    }
    for (const it of hit) kbBox.appendChild(kbRow(it));
  }

  /** 探测面板：空列表常驻，或点「探测并添加」叠在列表上方 */
  function renderProbePanel({ empty }) {
    const wrap = el('div', 'model-probe' + (empty ? '' : ' model-probe-overlay'));
    const titleRow = el('div', 'model-probe-title');
    titleRow.appendChild(el('b', null, empty ? '还没有模型 — 先探测导入' : '探测并添加模型'));
    if (!empty) {
      const close = el('button', 'set-btn tiny', '取消');
      close.type = 'button';
      close.addEventListener('click', () => closeProbePanel());
      titleRow.appendChild(close);
    }
    wrap.appendChild(titleRow);
    wrap.appendChild(
      el(
        'span',
        'model-probe-desc',
        empty
          ? '填接口地址和 Key，探测 OpenAI 兼容的 /models，勾选后导入。也可点「手动添加」建空壳。'
          : '用新地址探测上游有哪些模型，勾选后追加到列表。已有可用模型时，探测失败会尝试 AI 纠错。',
      ),
    );

    const urlInput = el('input');
    urlInput.value = probe.baseURL;
    urlInput.spellcheck = false;
    urlInput.placeholder = 'https://api.openai.com/v1';
    urlInput.addEventListener('input', () => {
      probe.baseURL = urlInput.value;
    });
    const proxyBtn = el('button', 'set-btn tiny', '改成本地转发地址');
    proxyBtn.type = 'button';
    proxyBtn.addEventListener('click', () => {
      probe.baseURL = localProxyUrl(urlInput.value);
      urlInput.value = probe.baseURL;
      toast('已改为本地转发地址（先确保 bun run dev 在跑）');
    });
    const urlStack = el('div', 'fld-stack');
    urlStack.append(urlInput, proxyBtn);
    wrap.appendChild(field('接口地址', urlStack, '官方 API 常缺 CORS —— 直连失败就改用本地转发'));

    const keyInput = el('input');
    keyInput.type = 'password';
    keyInput.value = probe.apiKey;
    keyInput.spellcheck = false;
    keyInput.autocomplete = 'off';
    keyInput.placeholder = 'sk-…';
    keyInput.addEventListener('input', () => {
      probe.apiKey = keyInput.value;
    });
    const peek = el('button', 'set-btn tiny', '显示');
    peek.type = 'button';
    peek.addEventListener('click', () => {
      const show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      peek.textContent = show ? '隐藏' : '显示';
    });
    const keyRow = el('div', 'key-row');
    keyRow.append(keyInput, peek);
    const keyHint = analyzerConfig()
      ? '只发给上面这个地址；若返回网页/协议不对，会用当前可用模型做 AI 分析'
      : '只发给上面这个地址；还没有可用模型时，失败只给规则提示';
    wrap.appendChild(field('API Key', keyRow, keyHint));

    const actions = el('div', 'drawer-actions');
    const run = el('button', 'set-btn primary', probe.running ? '探测中…' : '开始探测');
    run.type = 'button';
    run.disabled = probe.running || probe.aiRunning;
    actions.appendChild(run);
    wrap.appendChild(actions);

    const status = el('div', 'test-result');
    if (probe.message) {
      status.className =
        'test-result ' + (probe.kind === 'ok' ? 'ok' : probe.running || probe.aiRunning ? 'running' : 'bad');
      status.textContent = probe.message + (probe.aiRunning ? ' · 正在用当前模型分析…' : '');
    }
    wrap.appendChild(status);

    if (probe.kind && probe.kind !== 'ok' && probe.message) {
      const box = el('div', 'model-diagnose' + (probe.ai ? ' has-ai' : ''));
      box.appendChild(el('div', 'model-diagnose-title', probe.ai ? 'AI 分析' : '可能原因'));
      if (probe.ai?.diagnosis) box.appendChild(el('p', 'model-diagnose-body', probe.ai.diagnosis));
      const hints = probe.ai?.hints?.length ? probe.ai.hints : ruleHintsForKind(probe.kind);
      if (hints.length) {
        const ul = el('ul', 'model-diagnose-hints');
        for (const h of hints) ul.appendChild(el('li', null, h));
        box.appendChild(ul);
      }
      if (probe.ai?.suggestedBaseURL) {
        const apply = el('button', 'set-btn tiny', '应用建议的地址');
        apply.type = 'button';
        apply.addEventListener('click', () => {
          probe.baseURL = probe.ai.suggestedBaseURL;
          urlInput.value = probe.baseURL;
          toast('已填入建议地址，再点「开始探测」');
          renderModels();
        });
        box.appendChild(apply);
      }
      wrap.appendChild(box);
    }

    if (probe.models.length) {
      const pickHead = el('div', 'model-probe-pick-head');
      pickHead.appendChild(el('span', null, `探测到 ${probe.models.length} 个，勾选要导入的`));
      const allBtn = el('button', 'set-btn tiny', '全选');
      allBtn.type = 'button';
      const noneBtn = el('button', 'set-btn tiny', '全不选');
      noneBtn.type = 'button';
      allBtn.addEventListener('click', () => {
        for (const row of probe.models) row.checked = true;
        renderModels();
      });
      noneBtn.addEventListener('click', () => {
        for (const row of probe.models) row.checked = false;
        renderModels();
      });
      pickHead.append(allBtn, noneBtn);
      wrap.appendChild(pickHead);

      const pick = el('div', 'model-probe-pick');
      for (const row of probe.models) {
        const lab = el('label', 'model-probe-item');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = row.checked;
        cb.addEventListener('change', () => {
          row.checked = cb.checked;
        });
        lab.append(cb, el('span', null, row.name || row.id));
        pick.appendChild(lab);
      }
      wrap.appendChild(pick);

      const importBtn = el('button', 'set-btn primary', '导入所选');
      importBtn.type = 'button';
      importBtn.addEventListener('click', async () => {
        const chosen = probe.models.filter((r) => r.checked);
        if (!chosen.length) {
          toast('先勾选至少一个模型');
          return;
        }
        const base = probe.baseURL.trim().replace(/\/+$/, '');
        const keyVal = probe.apiKey;
        importBtn.disabled = true;
        try {
          let first = null;
          for (const row of chosen) {
            const created = await models.create({
              name: row.name || row.id,
              provider: hostOf(base),
              baseURL: base,
              apiKey: keyVal,
              model: row.id,
            });
            if (!first) first = created;
          }
          probe.open = false;
          resetProbeResults();
          if (first) {
            expanded = first.id;
            try {
              await models.activate(first.id);
            } catch (e) {
              /* 列表已写入，激活失败不挡导入结果 */
            }
          }
          await afterChange(`已导入 ${chosen.length} 个模型`);
        } catch (e) {
          toast('导入失败：' + e.message);
          importBtn.disabled = false;
        }
      });
      wrap.appendChild(importBtn);
    }

    run.addEventListener('click', async () => {
      probe.baseURL = urlInput.value.trim();
      probe.apiKey = keyInput.value;
      probe.running = true;
      probe.message = '正在探测…';
      probe.kind = '';
      probe.models = [];
      probe.ai = null;
      probe.aiRunning = false;
      renderModels();
      const result = await listRemoteModels({ baseURL: probe.baseURL, apiKey: probe.apiKey });
      probe.running = false;
      probe.kind = result.kind;
      probe.message = result.message;
      probe.snippet = result.snippet || '';
      probe.contentType = result.contentType || '';
      probe.status = result.status || 0;
      if (result.kind === 'ok' && result.models?.length) {
        probe.models = result.models.slice(0, 80).map((row, i) => ({
          id: row.id,
          name: row.name || row.id,
          checked: i < 20,
        }));
        if (result.models.length > 80) {
          probe.message = `${result.message}（只显示前 80 个）`;
        }
        renderModels();
        return;
      }
      probe.models = [];
      renderModels();

      const needAi = result.kind === 'html' || result.kind === 'shape';
      const analyzer = needAi ? analyzerConfig() : null;
      if (!analyzer) return;
      probe.aiRunning = true;
      probe.message = result.message;
      renderModels();
      try {
        probe.ai = await diagnoseUpstream({
          analyzer,
          failed: result,
          userBaseURL: probe.baseURL,
          userModel: '',
        });
      } catch (e) {
        probe.ai = null;
        probe.message = result.message + '（AI 分析未完成：' + e.message + '）';
      }
      probe.aiRunning = false;
      renderModels();
    });

    return wrap;
  }

  function renderModels() {
    if (!listBox) return;
    const snap = models.snapshot();
    const q = search.trim().toLowerCase();
    const hit = q ? snap.models.filter((m) => `${m.name} ${m.provider} ${m.model} ${m.baseURL}`.toLowerCase().includes(q)) : snap.models;
    listBox.textContent = '';
    listBox.classList.remove('is-empty');

    const showProbe = !snap.models.length || probe.open;
    if (!snap.models.length) {
      listBox.classList.add('is-empty');
      listBox.appendChild(renderProbePanel({ empty: true }));
      return;
    }

    if (showProbe) {
      listBox.appendChild(renderProbePanel({ empty: false }));
    }

    if (!hit.length) {
      if (!showProbe) listBox.classList.add('is-empty');
      listBox.appendChild(el('div', 'mp-empty', '没有匹配的模型'));
      return;
    }
    const activeId = snap.active && snap.active.enabled ? snap.active.id : null;
    for (const m of hit) listBox.appendChild(renderRow(m, activeId));
  }

  fill();
  renderStatusLine();
  return {
    open,
    switchTab,
    /** 模型列表在别处被改过（输入框里切换了）→ 重画 */
    refreshModels: renderModels,
    renderStatusLine,
  };
}
