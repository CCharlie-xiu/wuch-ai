import { defineComponent, num } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Skeleton',
  group: 'Feedback',
  description: '占位骨架',
  params: [
    num('lines', { default: 3 }),
  ],
  render: {
    create(p) {
      const n = el('div', 'skeleton');
      for (let i = 0; i < (p.lines || 3); i++) n.appendChild(el('div', 'skeleton-line'));
      return n;
    },
  },
  css: `
.skeleton { display: flex; flex-direction: column; gap: 7px; }
.skeleton-line { height: 11px; border-radius: 999px; background: linear-gradient(100deg, #f1f1f3 30%, #e6e6ea 50%, #f1f1f3 70%); background-size: 220% 100%; animation: shimmer 1.4s linear infinite; }
`,
});
