import { defineComponent, list } from '../define.js';
import { el } from '../dom.js';
import Tag from './Tag.js';

export default defineComponent({
  name: 'TagBlock',
  group: 'Content',
  description: '一组标签',
  skeleton: { lines: 1 },
  params: [
    list('tags', { required: true }),
  ],
  render: {
    create(p) {
      const n = el('div', 'tag-block');
      for (const t of p.tags || []) n.appendChild(Tag.render.create({ label: typeof t === 'string' ? t : t?.label, variant: typeof t === 'string' ? 'neutral' : t?.variant }));
      return n;
    },
    updates: ['tags'],
    update(n, p) {
      n.innerHTML = '';
      for (const t of p.tags || []) n.appendChild(Tag.render.create({ label: typeof t === 'string' ? t : t?.label, variant: typeof t === 'string' ? 'neutral' : t?.variant }));
    },
  },
  css: `
.tag-block { display: flex; flex-wrap: wrap; gap: 6px; }
`,
});
