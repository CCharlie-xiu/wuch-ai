import { defineComponent, nodes, str } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'TabItem',
  group: 'Layout',
  description: '标签页单项',
  params: [
    str('id', { required: true }),
    str('label', { required: true }),
    nodes('children'),
  ],
  render: { create: () => el('div', 'tab-pane') },
  css: `
.tab-pane { padding-top: 10px; display: flex; flex-direction: column; gap: 10px; }
`,
});
