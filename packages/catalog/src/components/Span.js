import { defineComponent, str, bool, textColor, textSize, textWeight } from '../define.js';

export default defineComponent({
  name: 'Span',
  group: 'Content',
  description: 'RichText 里的一段文字：单独指定颜色 / 粗细 / 字号 / 斜体',
  data: true,
  params: [
    str('text', { required: true }),
    textColor('color'),
    textWeight('weight'),
    textSize('size'),
    bool('italic', { default: false }),
  ],
});
