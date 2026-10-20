import { defineComponent, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'CardHeader',
  group: 'Layout',
  description: '卡片标题区：主标题 + 副标题',
  skeleton: { lines: 2 },
  params: [
    str('title', { required: true }),
    str('subtitle'),
  ],
  render: {
    create(p) {
      const n = el('div', 'card-header');
      n.appendChild(el('div', 'card-title', p.title));
      if (p.subtitle) n.appendChild(el('div', 'card-subtitle', p.subtitle));
      return n;
    },
  },
  markdown: (p) => `**${p.title ?? ''}**${p.subtitle ? ' — ' + p.subtitle : ''}`,
  css: `
.card-header { display: flex; flex-direction: column; gap: 2px; }
.card-title { font-size: 14.5px; font-weight: 650; letter-spacing: -.01em; }
.card-subtitle { font-size: 12px; color: var(--muted); }
`,
});
