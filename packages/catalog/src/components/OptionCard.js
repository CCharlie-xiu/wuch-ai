import { defineComponent, str } from '../define.js';
import { el, icon } from '../dom.js';

export default defineComponent({
  name: 'OptionCard',
  group: 'Forms',
  description: '卡片选项，放在 OptionCards 里，点一下即选中',
  skeleton: { frame: true, lines: 2 },
  params: [
    str('value', { required: true }),
    str('title', { required: true }),
    str('description'),
    str('icon'),
  ],
  render: {
    create(p, ctx) {
      const n = el('button', 'opt-card');
      n.type = 'button';
      if (p.icon) n.appendChild(icon(p.icon, 'icon sm'));
      n.appendChild(el('div', 'opt-title', p.title));
      if (p.description) n.appendChild(el('div', 'opt-desc', p.description));
      n.addEventListener('click', () => {
        for (const sib of n.parentNode ? n.parentNode.children : []) sib.classList.toggle('on', sib === n);
        ctx.emit('select', p.value);
      });
      return n;
    },
  },
  css: `
/* 可选项是「块」：底色划界；选中才上主色边（那是状态，不是默认边界） */
.opt-card { font: inherit; text-align: left; cursor: pointer; background: var(--ui-band, rgba(17,24,39,.035)); border: 1px solid transparent; border-radius: 11px; padding: 12px 14px; display: flex; flex-direction: column; gap: 3px; min-width: 130px; color: var(--text); transition: background .16s ease, border-color .16s ease; }
.opt-card:hover { background: var(--ui-band-strong, rgba(17,24,39,.07)); }
.opt-title { font-weight: 650; font-size: 13px; }
.opt-desc { font-size: 11.5px; color: var(--ui-ink-3); }
.opt-card.on { border-color: var(--accent); background: var(--accent-soft); }
`,
});
