import { defineComponent, num, str, bool } from '../define.js';

export default defineComponent({
  name: 'Arrow',
  group: 'Canvas',
  skill: 'canvas',
  description: '箭头图元（只写在 Drawing 的 shapes 里）：从 (x1, y1) 指向 (x2, y2)，label 写在线段中点上方',
  data: true,
  typed: true,
  params: [
    num('x1', { required: true }),
    num('y1', { required: true }),
    num('x2', { required: true }),
    num('y2', { required: true }),
    str('stroke'),
    num('width', { default: 2 }),
    str('label'),
    bool('dashed', { default: false }),
  ],
});
