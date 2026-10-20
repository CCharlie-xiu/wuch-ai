import { defineComponent, num, list } from '../define.js';
import { el } from '../dom.js';
import Image from './Image.js';

export default defineComponent({
  name: 'ImageGallery',
  group: 'Media',
  description: '图片网格：images 是图片地址数组，或 Image 数组',
  skeleton: { h: 160 },
  params: [
    list('images', { required: true }),
    num('columns', { default: 3 }),
  ],
  render: {
    create(p) {
      const n = el('div', 'gallery');
      n.style.gridTemplateColumns = `repeat(${p.columns || 3}, 1fr)`;
      for (const img of p.images || []) {
        const props = typeof img === 'string' ? { src: img } : img;
        if (props && props.src) n.appendChild(Image.render.create({ aspectRatio: '1:1', ...props }));
      }
      return n;
    },
  },
});
