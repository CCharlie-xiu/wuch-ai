import { defineComponent, num, str } from '../define.js';

export default defineComponent({
  name: 'Rect',
  group: 'Canvas',
  skill: 'canvas',
  description: '矩形图元（只写在 Drawing 的 shapes 里）：左上角 x, y，宽 w、高 h，可在中心写 label',
  data: true,
  typed: true,
  params: [
    num('x', { required: true }),
    num('y', { required: true }),
    num('w', { required: true }),
    num('h', { required: true }),
    str('fill'),
    str('stroke'),
    num('radius', { default: 0 }),
    str('label'),
    str('labelColor'),
  ],
});
