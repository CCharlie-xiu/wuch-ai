import { defineComponent, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Citation',
  group: 'Content',
  description: '引用来源条目',
  skeleton: { frame: true, lines: 2 },
  params: [
    str('title', { required: true }),
    str('url'),
    str('snippet'),
  ],
  render: {
    create(p) {
      const n = el('a', 'citation');
      n.href = p.url || '#';
      n.target = '_blank';
      n.rel = 'noreferrer';
      n.appendChild(el('span', 'cite-index', '·'));
      const body = el('span', 'cite-body');
      body.appendChild(el('span', 'cite-title', p.title));
      if (p.snippet) body.appendChild(el('span', 'cite-snippet', p.snippet));
      n.appendChild(body);
      return n;
    },
  },
  css: `
.cite-index { color: var(--text); }
.cite-body { display: flex; flex-direction: column; }
.cite-snippet { font-size: 11.5px; color: var(--ui-ink-2); }
`,
});
