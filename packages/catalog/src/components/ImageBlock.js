import { defineComponent, str } from '../define.js';
import Image from './Image.js';

export default defineComponent({
  name: 'ImageBlock',
  group: 'Media',
  description: '图片 + 说明',
  skeleton: { ratio: '16 / 9' },
  params: [
    str('src', { required: true }),
    str('alt'),
    str('caption'),
  ],
  render: { create: (p) => Image.render.create(p) },
  markdown: (p) => `![${p.caption || p.alt || p.query || '图片'}](图片由服务端提供)`,
});
