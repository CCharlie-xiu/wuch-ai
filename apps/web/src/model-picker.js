// ─────────────────────────────────────────────────────────────────────────────
// 输入框右下角的模型切换器：点开是一个带搜索框的列表，按「分组」归类，当前那个打勾。
// 只列开着的模型 —— 设置里关掉的不会出现在这里。
//
// 列表来自服务端（/api/models），切换会写回服务端，所以换个浏览器打开还是同一个。
// ─────────────────────────────────────────────────────────────────────────────

import { modelSub } from './models.js';

const ICON = {
  tick: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/></svg>',
};

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

/**
 * @param {object} o
 * @param {HTMLButtonElement} o.button   输入框右下角的那个按钮
 * @param {HTMLElement} o.label          按钮上的文字
 * @param {HTMLElement} o.menu           气泡菜单容器（初始 hidden）
 * @param {object} o.store               models.js 的 store
 * @param {(m: object) => void} o.onPick 选中某个模型
 * @param {() => void} o.onManage        去设置里管理
 */
export function createModelPicker({ button, label, menu, store, onPick, onManage }) {
  let query = '';

  /** 当前生效的那个：服务端记的那个还开着就用它，否则退回第一个开着的 */
  const currentOf = (snap) => (snap.active && snap.active.enabled ? snap.active : snap.enabled[0] || null);

  function renderButton() {
    const current = currentOf(store.snapshot());
    label.textContent = current ? current.name : '未配置模型';
    button.classList.toggle('unset', !current);
    button.title = current ? `${current.name} · ${modelSub(current)}` : '还没有可用的模型，点这里去设置里加一个';
  }

  function item(m, activeId) {
    const b = el('button', 'mp-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(m.id === activeId));
    const text = el('span', 'mp-text');
    text.appendChild(el('span', 'mp-name')).textContent = m.name;
    text.appendChild(el('span', 'mp-sub')).textContent = modelSub(m);
    b.appendChild(text);
    if (m.id === activeId) b.appendChild(el('span', 'mp-tick', ICON.tick));
    b.addEventListener('click', () => {
      close();
      if (m.id !== activeId) onPick && onPick(m);
    });
    return b;
  }

  /** 按当前搜索词过滤，再按「分组」归类（分组顺序跟着库里 sort 排好的顺序走） */
  function fillList(list) {
    const snap = store.snapshot();
    const q = query.trim().toLowerCase();
    const hit = snap.enabled.filter((m) => !q || `${m.name} ${m.provider} ${m.model} ${m.baseURL}`.toLowerCase().includes(q));
    list.textContent = '';
    if (!snap.models.length) {
      list.appendChild(el('div', 'mp-empty', '还没有模型。在设置 › 模型配置里加一个。'));
      return;
    }
    if (!snap.enabled.length) {
      list.appendChild(el('div', 'mp-empty', '所有模型都被关掉了。在设置里打开一个开关。'));
      return;
    }
    if (!hit.length) {
      list.appendChild(el('div', 'mp-empty', '没有匹配的模型'));
      return;
    }
    const groups = new Map();
    for (const m of hit) {
      const key = m.provider || '其他';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const currentId = currentOf(snap)?.id ?? null;
    for (const [name, items] of groups) {
      list.appendChild(el('div', 'mp-group', name));
      for (const m of items) list.appendChild(item(m, currentId));
    }
  }

  function build() {
    menu.textContent = '';

    const box = el('div', 'mp-search');
    box.appendChild(el('span', 'mp-search-icon', ICON.search));
    const input = el('input');
    input.type = 'search';
    input.placeholder = '搜索模型';
    input.spellcheck = false;
    input.value = query;
    box.appendChild(input);
    menu.appendChild(box);

    const list = el('div', 'mp-list');
    menu.appendChild(list);
    fillList(list);

    const foot = el('button', 'mp-foot');
    foot.type = 'button';
    foot.appendChild(el('span', 'mp-foot-icon', ICON.gear));
    foot.appendChild(el('span', null, '在设置里管理模型'));
    foot.addEventListener('click', () => {
      close();
      onManage && onManage();
    });
    menu.appendChild(foot);

    input.addEventListener('input', () => {
      query = input.value;
      fillList(list); // 只换列表，输入框不动，光标留在原处
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        button.focus();
      }
    });
  }

  const isOpen = () => !menu.classList.contains('hidden');

  /**
   * 菜单挂在 #composer 上，但触发它的是底部的按钮 —— 所以水平和垂直都得按按钮算。
   * 光写 bottom: 100% 会让它飘到整条输入框（含文本框）的上方，离按钮老远。
   *
   * 右边缘对齐按钮右边缘；下边缘贴在按钮上边之上 8px；高度按按钮上方剩余的空间收，
   * 免得模型多了顶出窗口。
   */
  function place() {
    const host = menu.parentElement; // #composer，position: relative
    if (!host || !button.isConnected) return;
    const hb = host.getBoundingClientRect();
    const bb = button.getBoundingClientRect();
    menu.style.setProperty('--mp-right', Math.max(8, Math.round(hb.right - bb.right)) + 'px');
    menu.style.setProperty('--mp-bottom', Math.max(8, Math.round(hb.bottom - bb.top + 8)) + 'px');
    menu.style.setProperty('--mp-max', Math.round(Math.max(180, Math.min(window.innerHeight * 0.62, bb.top - 16))) + 'px');
  }

  function open() {
    query = '';
    build();
    place();
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    const input = menu.querySelector('.mp-search input');
    if (input) input.focus({ preventScroll: true });
  }

  function close() {
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('active');
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });
  document.addEventListener('click', (e) => {
    if (isOpen() && !menu.contains(e.target)) close();
  });
  window.addEventListener('resize', () => isOpen() && place());

  renderButton();

  return {
    close,
    /** 配置变了（设置页里改了 / 服务端重新拉过）→ 刷新按钮上的名字 */
    refresh() {
      renderButton();
      if (isOpen()) build();
    },
  };
}
