import { defineComponent, enumOf } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Separator',
  group: 'Layout',
  description: '水平分隔线',
  params: [
    enumOf('variant', ['solid', 'dashed'], { default: 'solid' }),
  ],
  render: { create: (p) => el('hr', p.variant === 'dashed' ? 'sep dashed' : 'sep') },
  markdown: () => '---',
  css: `
.sep { border: 0; border-top: 1px solid var(--ui-line, rgba(17,24,39,.06)); margin: 2px 0; width: 100%; }
.sep.dashed { border-top-style: dashed; }
`,
});
