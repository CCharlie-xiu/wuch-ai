import { defineComponent, nodes } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Timeline',
  group: 'Layout',
  description: '时间线，包含若干 TimelineItem',
  skeleton: { lines: 6 },
  params: [
    nodes('items'),
  ],
  render: { create: () => el('div', 'timeline') },
  css: `
.timeline { display: flex; flex-direction: column; }
`,
});
