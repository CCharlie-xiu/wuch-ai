// ─────────────────────────────────────────────────────────────────────────────
// 输入框「+」：气泡菜单（上传文件 / 技能 / 更多）+ 技能 chip。
//
// 选中的技能以 chip 挂在「+」右边，只有挂着 chip 时，对应组件、提示词和工具才交给模型。
// chip 在同一会话里一直留着，直到用户点 × 关掉；默认单选（和 Gemini 一致），数据结构是数组。
// ─────────────────────────────────────────────────────────────────────────────

const ICON = {
  clip: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.7a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  spark: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

/**
 * @param {object} o
 * @param {HTMLButtonElement} o.button       「+」按钮
 * @param {HTMLElement} o.chips              chip 容器
 * @param {HTMLElement} o.menu               气泡菜单容器（初始 hidden）
 * @param {HTMLInputElement} o.fileInput     隐藏的文件选择框
 * @param {HTMLTextAreaElement} o.prompt     输入框（占位文字随技能变）
 * @param {object[]} o.skills                内置技能（catalog 的 SKILLS）
 * @param {(ids: string[]) => void} o.onChange
 * @param {(files: File[]) => void} o.onUpload
 * @param {() => void} o.onExample
 */
export function createComposerMenu({ button, chips, menu, fileInput, prompt, skills, onChange, onUpload, onExample }) {
  const basePlaceholder = prompt.placeholder;
  let selected = [];
  let external = []; // 数据库里启用的外部技能（本期为空）
  const byId = () => new Map([...skills, ...external].map((s) => [s.id, s]));

  function set(ids, { silent = false } = {}) {
    const known = byId();
    const next = (ids || []).filter((id) => known.has(id)).slice(0, 1);
    const changed = next.join() !== selected.join();
    selected = next;
    renderChips();
    if (changed && !silent) onChange && onChange(selected.slice());
  }

  function renderChips() {
    chips.textContent = '';
    const known = byId();
    for (const id of selected) {
      const s = known.get(id);
      if (!s) continue;
      const chip = el('span', 'skill-chip');
      chip.title = s.description || s.name;
      chip.appendChild(el('span', 'skill-chip-icon', s.icon || ICON.spark));
      chip.appendChild(el('span', 'skill-chip-name')).textContent = s.name;
      const x = el('button', 'skill-chip-x', ICON.x);
      x.type = 'button';
      x.title = `不再使用 ${s.name}`;
      x.setAttribute('aria-label', `移除技能 ${s.name}`);
      x.addEventListener('click', () => set(selected.filter((v) => v !== id)));
      chip.appendChild(x);
      chips.appendChild(chip);
    }
    const first = known.get(selected[0]);
    prompt.placeholder = first?.placeholder || basePlaceholder;
  }

  function item({ icon, label, desc, onClick, tick, trailing, disabled }) {
    const b = el('button', 'add-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.appendChild(el('span', 'add-icon', icon || ''));
    const text = el('span', 'add-text');
    text.appendChild(el('b')).textContent = label;
    if (desc) text.appendChild(el('small')).textContent = desc;
    b.appendChild(text);
    if (tick) b.appendChild(el('span', 'add-tick', '✓'));
    if (trailing) b.appendChild(el('span', 'add-trailing', trailing));
    if (disabled) b.disabled = true;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick && onClick(b);
    });
    return b;
  }

  function build() {
    menu.textContent = '';
    menu.appendChild(
      item({
        icon: ICON.clip,
        label: '添加文件',
        desc: '图片 / 表格 / 文档（pdf · docx · pptx）/ 文本，也可以直接拖进来',
        onClick: () => {
          close();
          fileInput.click();
        },
      }),
    );
    menu.appendChild(el('div', 'add-sep'));
    menu.appendChild(el('div', 'add-label')).textContent = '技能';
    for (const s of skills) {
      menu.appendChild(
        item({
          icon: s.icon,
          label: s.name,
          desc: s.description,
          tick: selected.includes(s.id),
          onClick: () => {
            set(selected.includes(s.id) ? [] : [s.id]);
            close();
            prompt.focus();
          },
        }),
      );
    }
    const more = item({ icon: ICON.dots, label: '更多技能', trailing: ICON.chevron, onClick: (b) => toggleSub(b) });
    more.setAttribute('aria-haspopup', 'menu');
    menu.appendChild(more);
    menu.appendChild(el('div', 'add-sep'));
    menu.appendChild(
      item({
        icon: ICON.spark,
        label: '填一条示例',
        onClick: () => {
          close();
          onExample && onExample();
        },
      }),
    );
  }

  let sub = null;
  function toggleSub(anchor) {
    if (sub) {
      sub.remove();
      sub = null;
      return;
    }
    sub = el('div', 'add-sub menu');
    sub.setAttribute('role', 'menu');
    if (!external.length) sub.appendChild(item({ label: '还没有外部技能', desc: '在设置 › Skill 列表里接入后会出现在这里', disabled: true }));
    for (const s of external) {
      sub.appendChild(
        item({
          icon: s.icon || ICON.spark,
          label: s.name,
          desc: s.description,
          tick: selected.includes(s.id),
          onClick: () => {
            set(selected.includes(s.id) ? [] : [s.id]);
            close();
          },
        }),
      );
    }
    menu.appendChild(sub);
    sub.style.top = anchor.offsetTop + 'px';
  }

  function open() {
    build();
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    const first = menu.querySelector('.add-item:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  function close() {
    if (sub) {
      sub.remove();
      sub = null;
    }
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('active');
  }

  const isOpen = () => !menu.classList.contains('hidden');

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });
  document.addEventListener('click', (e) => {
    if (isOpen() && !menu.contains(e.target)) close();
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.add-item:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      button.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) next.focus();
    }
  });
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (files.length) onUpload && onUpload(files);
  });

  renderChips();

  return {
    get: () => selected.slice(),
    set,
    /** 外部技能（GET /api/skills 里 builtin = false 且启用的） */
    setExternal(list) {
      external = (list || []).filter((s) => s && s.id && !skills.some((b) => b.id === s.id));
      renderChips();
    },
    close,
  };
}
