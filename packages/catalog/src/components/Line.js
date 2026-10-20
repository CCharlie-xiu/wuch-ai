import { defineComponent, num, str, bool } from '../define.js';

export default defineComponent({
  name: 'Line',
  group: 'Canvas',
  skill: 'canvas',
  description: '线段图元（只写在 Drawing 的 shapes 里）：从 (x1, y1) 到 (x2, y2)',
  data: true,
  typed: true,
  params: [
    num('x1', { required: true }),
    num('y1', { required: true }),
    num('x2', { required: true }),
    num('y2', { required: true }),
    str('stroke'),
    num('width', { default: 2 }),
    bool('dashed', { default: false }),
  ],
});
