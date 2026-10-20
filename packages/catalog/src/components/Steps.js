import { defineComponent, num, list } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Steps',
  group: 'Layout',
  description: '步骤条',
  skeleton: { h: 44 },
  params: [
    list('items', { required: true }),
    num('current', { default: 0 }),
  ],
  render: {
    create(p) {
      const n = el('div', 'steps');
      (p.items || []).forEach((it, i) => {
        const s = el('div', 'step');
        if (i < (p.current || 0)) s.classList.add('done');
        if (i === (p.current || 0)) s.classList.add('active');
        s.appendChild(el('span', 'step-dot', String(i + 1)));
        s.appendChild(el('span', 'step-label', typeof it === 'string' ? it : it?.label ?? ''));
        n.appendChild(s);
      });
      return n;
    },
  },
  markdown: (p) => (p.items || []).map((it, i) => `${i + 1}. ${typeof it === 'string' ? it : it?.label ?? ''}`).join('\n'),
  css: `
.step { display: flex; align-items: center; gap: 9px; color: var(--ui-ink-2); }
.step.done .step-dot { background: var(--ui-band-strong, rgba(17,24,39,.07)); color: var(--text); }
.step.active .step-dot { background: var(--accent); color: var(--accent-text); font-weight: 700; }
.step.active .step-label { color: var(--text); }
.steps { display: flex; flex-direction: column; gap: 8px; }
.step-dot { width: 20px; height: 20px; border-radius: 999px; background: var(--ui-band-strong, rgba(17,24,39,.07)); display: grid; place-items: center; font-size: 11px; }
`,
});
