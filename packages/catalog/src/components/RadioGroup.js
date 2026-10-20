import { defineComponent, nodes, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'RadioGroup',
  group: 'Forms',
  description: '单选组',
  skeleton: { lines: 3 },
  params: [
    str('name', { required: true }),
    nodes('items'),
    str('label'),
  ],
  render: { create: () => el('div', 'opt-group') },
});
