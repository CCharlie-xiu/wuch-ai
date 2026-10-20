import { defineComponent, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Cite',
  group: 'Content',
  description: '来源链接，由服务端按引用填充',
  serverResolved: true,
  skeleton: { inline: true, w: 40, h: 18 },
  params: [
    str('ref', { required: true }),
    str('label'),
  ],
  render: {
    create(p, ctx) {
      const resolved = p.__resolved || ctx.resolve(p.__id);
      const n = el('a', 'citation');
      n.href = resolved?.state?.url || p.label || '#';
      n.target = '_blank';
      n.rel = 'noreferrer';
      n.appendChild(el('span', 'cite-title', resolved?.state?.title || p.label || '来源'));
      return n;
    },
  },
});
