import { defineComponent, nodes, str, enumOf } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'OptionCards',
  group: 'Forms',
  description: '卡片式选项',
  skeleton: { h: 120 },
  params: [
    str('name', { required: true }),
    nodes('items'),
    enumOf('direction', ['row', 'column'], { default: 'row' }),
  ],
  render: { create: () => el('div', 'opt-cards') },
  css: `
.opt-cards { display: flex; gap: 8px; flex-wrap: wrap; }
`,
});
