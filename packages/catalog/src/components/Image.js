import { defineComponent, str, enumOf } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Image',
  group: 'Media',
  description: '图片',
  skeleton: { ratio: '16 / 9' },
  params: [
    str('src', { required: true }),
    str('alt'),
    str('aspectRatio'),
    str('maxWidth'),
    enumOf('fit', ['cover', 'contain'], { default: 'cover' }),
  ],
  render: {
    create(p) {
      const fig = el('figure', 'figure');
      const img = el('img', 'img');
      img.src = p.src;
      img.alt = p.alt || '';
      img.loading = 'lazy';
      if (p.aspectRatio) img.style.aspectRatio = String(p.aspectRatio).replace(':', ' / ');
      img.style.objectFit = p.fit || 'cover';
      if (p.maxWidth) fig.style.maxWidth = p.maxWidth;
      fig.appendChild(img);
      if (p.caption) fig.appendChild(el('figcaption', null, p.caption));
      return fig;
    },
  },
  markdown: (p) => `![${p.caption || p.alt || p.query || '图片'}](图片由服务端提供)`,
});
