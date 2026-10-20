import { defineComponent, str, bool, list } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Chips',
  group: 'Forms',
  description: '可点击标签组，multi 为 true 时可多选',
  skeleton: { h: 30 },
  params: [
    str('name', { required: true }),
    list('options', { required: true }),
    bool('multi', { default: false }),
  ],
  render: {
    create(p, ctx) {
      const n = el('div', 'chips');
      for (const o of p.options || []) {
        const label = typeof o === 'string' ? o : o?.label ?? o?.value;
        const value = typeof o === 'string' ? o : o?.value ?? o?.label;
        const chip = el('button', 'chip', label);
        chip.type = 'button';
        chip.addEventListener('click', () => {
          if (p.multi) chip.classList.toggle('on');
          else {
            Array.from(n.children).forEach((c) => c.classList.remove('on'));
            chip.classList.add('on');
          }
          ctx.emit('change', value);
        });
        n.appendChild(chip);
      }
      return n;
    },
  },
  css: `
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font: inherit; font-size: 12px; cursor: pointer; background: transparent; border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); color: var(--ui-ink-2); border-radius: 999px; padding: 4px 12px; transition: background .16s ease, border-color .16s ease, color .16s ease; }
.chip:hover { color: var(--text); border-color: rgba(17, 24, 39, .16); }
.chip.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
`,
});
