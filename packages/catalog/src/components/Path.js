import { defineComponent, list, str, bool, num } from '../define.js';

export default defineComponent({
  name: 'Path',
  group: 'Canvas',
  skill: 'canvas',
  description: '折线 / 多边形图元（只写在 Drawing 的 shapes 里）：points 写 [[x, y], ...]，closed 为 true 时首尾相连并可填充',
  data: true,
  typed: true,
  params: [
    list('points', { required: true }),
    str('stroke'),
    str('fill'),
    bool('closed', { default: false }),
    num('width', { default: 2 }),
  ],
});
