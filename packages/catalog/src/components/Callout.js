import { defineComponent, node, str, enumOf } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Callout',
  group: 'Content',
  description: '提示块，带标题与正文',
  skeleton: { frame: true, lines: 2 },
  params: [
    enumOf('variant', ['info', 'success', 'warning', 'danger', 'neutral'], { required: true, default: 'info' }),
    str('title'),
    node('children'),
  ],
  render: {
    create(p) {
      const n = el('div', 'callout');
      n.dataset.variant = p.variant || 'info';
      if (p.title) n.appendChild(el('div', 'callout-title', p.title));
      return n;
    },
  },
  markdown: (p) => `> ${[p.title, p.text].filter(Boolean).join(' ')}`,
});
