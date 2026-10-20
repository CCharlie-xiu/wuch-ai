import { defineComponent, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'InlineHeader',
  group: 'Content',
  description: '行内标题 + 说明文字',
  skeleton: { lines: 1 },
  params: [
    str('title', { required: true }),
    str('subtitle'),
  ],
  render: {
    create(p) {
      const n = el('div', 'inline-header');
      n.appendChild(el('span', 'inline-title', p.title));
      if (p.subtitle) n.appendChild(el('span', 'inline-subtitle', p.subtitle));
      return n;
    },
  },
  markdown: (p) => `**${p.title ?? ''}**${p.subtitle ? ' — ' + p.subtitle : ''}`,
  css: `
.inline-header { display: flex; align-items: baseline; gap: 8px; }
.inline-title { font-weight: 650; }
.inline-subtitle { font-size: 12px; color: var(--muted); }
`,
});
