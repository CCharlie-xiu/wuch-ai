// ─────────────────────────────────────────────────────────────────────────────
// 顶栏账号菜单：显示当前账号、改名字、切换 / 添加账号、退出登录。
//
// 「添加账号」和「退出」是路由跳转（/login?add=1 与 /login），
// 切换账号直接换 localStorage 里的当前 id 再 reload —— 会话、历史、界面全部重读，
// 不在内存里手动搬状态，省得两套账号的数据串在一起。
//
// 没有头像：这个产品不靠头像认人，靠名字 + 邮箱。
// ─────────────────────────────────────────────────────────────────────────────

import { currentAccount, listAccounts, switchTo, renameCurrent, signOut } from './accounts.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const ICON = {
  caret: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  add: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  out: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l5-5-5-5M15 12H3"/></svg>',
  pen: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/></svg>',
};

const providerLabel = (p) => (p === 'wechat' ? '微信' : p === 'github' ? 'GitHub' : '邮箱');

/**
 * @param {object} o
 * @param {(msg: string) => void} [o.toast]
 */
export function createAccountMenu({ toast = () => {} } = {}) {
  const host = $('#account-btn');
  if (!host) return null;

  let open = false;
  let renaming = false;
  let menu = null;

  const me = () => currentAccount();
  const nextUrl = () => `${location.pathname}${location.search}`;

  function paintButton() {
    const a = me();
    if (!a) return;
    const name = host.querySelector('.account-name');
    if (name) name.textContent = a.name;
    host.title = `${a.name} · ${a.email}`;
  }

  function close({ focus = false } = {}) {
    if (!open) return;
    open = false;
    renaming = false;
    host.setAttribute('aria-expanded', 'false');
    if (menu) {
      menu.hidden = true;
      menu.textContent = '';
    }
    if (focus) host.focus();
  }

  function mount() {
    if (menu) return menu;
    menu = el('div', 'account-menu');
    menu.id = 'account-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '账号');
    menu.hidden = true;
    host.parentElement.appendChild(menu);
    return menu;
  }

  function item(iconSvg, label, onClick, { danger = false, muted = false, tag = '' } = {}) {
    const b = el('button', `am-item${danger ? ' danger' : ''}${muted ? ' am-item-muted' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (iconSvg) b.insertAdjacentHTML('beforeend', iconSvg);
    b.appendChild(el('span', null, label));
    if (tag) b.appendChild(el('span', 'am-tag', tag));
    b.addEventListener('click', onClick);
    return b;
  }

  function startRename() {
    renaming = true;
    render();
  }

  function render() {
    const box = mount();
    box.textContent = '';
    const a = me();
    if (!a) return;

    const head = el('div', 'am-head');
    head.appendChild(el('p', 'am-name', a.name));
    head.appendChild(el('p', 'am-mail', a.email));
    box.appendChild(head);

    if (renaming) {
      const row = el('div', 'am-rename');
      const input = el('input');
      input.type = 'text';
      input.value = a.name;
      input.maxLength = 24;
      input.spellcheck = false;
      input.setAttribute('aria-label', '新的名字');
      const save = el('button', null, '保存');
      save.type = 'button';
      save.disabled = true;

      const sync = () => {
        const v = input.value.trim();
        save.disabled = !v || v === a.name;
      };
      input.addEventListener('input', sync);
      const commit = () => {
        const v = input.value.trim();
        if (!v || v === a.name) return;
        const out = renameCurrent(v);
        if (out) toast?.(`名字已改为「${out.name}」`);
        renaming = false;
        paintButton();
        render();
      };
      save.addEventListener('click', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          renaming = false;
          render();
        }
      });
      row.append(input, save);
      box.appendChild(row);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    } else {
      box.appendChild(item(ICON.pen, '改名字', startRename));
    }

    const others = listAccounts().filter((x) => x.id !== a.id);
    box.appendChild(el('div', 'am-sec', others.length ? '切换账号' : '只有一个账号'));
    box.appendChild(
      item(ICON.check, a.name, () => close(), { tag: '当前' }),
    );
    for (const o of others) {
      box.appendChild(
        item(null, o.name, () => {
          if (switchTo(o.id)) location.reload();
        }, { tag: providerLabel(o.provider) }),
      );
    }

    box.appendChild(el('div', 'am-sep'));
    box.appendChild(
      item(ICON.add, '添加账号', () => {
        location.assign(`/login?add=1&next=${encodeURIComponent(nextUrl())}`);
      }),
    );
    box.appendChild(
      item(ICON.out, '退出登录', () => {
        close();
        signOut();
        location.assign('/login');
      }, { danger: true }),
    );

    // 让菜单贴着右上角，并在窄屏收一点宽度
    box.style.width = window.matchMedia('(max-width: 560px)').matches ? '268px' : '';
  }

  function toggle() {
    if (open) close({ focus: true });
    else {
      open = true;
      renaming = false;
      host.setAttribute('aria-expanded', 'true');
      render();
      menu.hidden = false;
      const first = menu.querySelector('.am-item');
      first?.focus({ preventScroll: true });
    }
  }

  host.innerHTML = '';
  host.setAttribute('aria-haspopup', 'menu');
  host.setAttribute('aria-expanded', 'false');
  host.setAttribute('type', 'button');
  host.append(
    el('span', 'account-dot'),
    el('span', 'account-name', me()?.name || '账号'),
    (() => {
      const n = el('span', 'account-caret');
      n.innerHTML = ICON.caret;
      return n;
    })(),
  );

  host.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    if (menu?.contains(e.target) || host.contains(e.target)) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close({ focus: true });
    }
  });
  window.addEventListener('resize', () => open && close());

  paintButton();
  // 账号可能在别的标签页里被改过（演示时经常开两个）
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key.startsWith('wuch-ai.')) paintButton();
  });

  return { paint: paintButton, close };
}
