import { defineComponent, nodes } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Accordion',
  group: 'Layout',
  description: '折叠面板，包含若干 AccordionItem',
  skeleton: { lines: 3 },
  params: [
    nodes('items'),
  ],
  render: { create: () => el('div', 'accordion') },
  css: `
.accordion { display: flex; flex-direction: column; gap: 6px; }
`,
});
