import { defineComponent, nodes, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Sources',
  group: 'Content',
  description: '来源列表',
  skeleton: { lines: 3 },
  params: [
    nodes('items'),
    str('title', { default: 'Sources' }),
  ],
  render: {
    create(p) {
      const n = el('div', 'sources');
      n.appendChild(el('div', 'sources-title', p.title || 'Sources'));
      return n;
    },
  },
  css: `
.sources { display: flex; flex-direction: column; gap: 6px; }
.sources-title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }
`,
});
