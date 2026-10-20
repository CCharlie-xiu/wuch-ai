import { defineComponent, nodes } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'SwitchGroup',
  group: 'Forms',
  description: '开关组',
  skeleton: { lines: 3 },
  params: [
    nodes('items'),
  ],
  render: { create: () => el('div', 'opt-group') },
});
