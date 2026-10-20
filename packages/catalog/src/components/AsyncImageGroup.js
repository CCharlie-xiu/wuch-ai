import { defineComponent, str, list } from '../define.js';
import { el } from '../dom.js';
import AsyncImage from './AsyncImage.js';

export default defineComponent({
  name: 'AsyncImageGroup',
  group: 'Media',
  description: '由服务端解析的图片轮播',
  serverResolved: true,
  skeleton: { h: 160 },
  params: [
    list('queries', { required: true }),
    str('caption'),
  ],
  render: {
    create(p, ctx) {
      const n = el('div', 'gallery');
      n.style.gridTemplateColumns = `repeat(${(p.queries || []).length || 1}, 1fr)`;
      (p.queries || []).forEach((q, i) => {
        n.appendChild(AsyncImage.render.create({ query: q, aspectRatio: '1:1', __id: p.__id + ':' + i }, ctx));
      });
      return n;
    },
  },
});
