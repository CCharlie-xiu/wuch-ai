import { defineComponent, nodes, enumOf } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Buttons',
  group: 'Forms',
  description: '按钮组',
  params: [
    nodes('children'),
    enumOf('direction', ['row', 'column'], { default: 'row' }),
  ],
  render: { create: () => el('div', 'buttons') },
});
