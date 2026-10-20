import { defineComponent, num, str } from '../define.js';

export default defineComponent({
  name: 'Circle',
  group: 'Canvas',
  skill: 'canvas',
  description: '圆形图元（只写在 Drawing 的 shapes 里）：圆心 cx, cy，半径 r，可在中心写 label',
  data: true,
  typed: true,
  params: [
    num('cx', { required: true }),
    num('cy', { required: true }),
    num('r', { required: true }),
    str('fill'),
    str('stroke'),
    str('label'),
    str('labelColor'),
  ],
});
