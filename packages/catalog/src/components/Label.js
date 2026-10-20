import { defineComponent, num, str, enumOf } from '../define.js';

export default defineComponent({
  name: 'Label',
  group: 'Canvas',
  skill: 'canvas',
  description: '文字图元（只写在 Drawing 的 shapes 里）：在 (x, y) 写 text，y 是文字的垂直中线',
  data: true,
  typed: true,
  params: [
    num('x', { required: true }),
    num('y', { required: true }),
    str('text', { required: true }),
    num('size', { default: 14 }),
    str('color'),
    enumOf('align', ['left', 'center', 'right'], { default: 'left' }),
    enumOf('weight', ['regular', 'bold'], { default: 'regular' }),
  ],
});
