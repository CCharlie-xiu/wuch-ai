import { defineComponent, enumOf, list } from '../define.js';
import { el } from '../dom.js';
import Entity from './Entity.js';

export default defineComponent({
  name: 'EntityList',
  group: 'Data',
  description: '实体卡片列表',
  serverResolved: true,
  skeleton: { lines: 4 },
  params: [
    list('refs', { required: true }),
    enumOf('kind', ['product', 'place'], { default: 'product' }),
  ],
  render: {
    create(p, ctx) {
      const n = el('div', 'entity-list');
      (p.refs || []).forEach((ref) => n.appendChild(Entity.render.create({ ref, kind: p.kind, __id: ref }, ctx)));
      return n;
    },
  },
  css: `
.entity-list { display: flex; flex-direction: column; gap: 8px; }
`,
});
