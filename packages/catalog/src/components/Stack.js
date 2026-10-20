import { defineComponent, nodes, bool, enumOf, space } from '../define.js';
import { el, px, styleVars } from '../dom.js';
import { MAX_WIDTHS } from '../tokens.js';

export default defineComponent({
  name: 'Stack',
  group: 'Layout',
  description: '弹性容器，按行或列排列子元素',
  params: [
    nodes('children'),
    enumOf('direction', ['row', 'column'], { default: 'column' }),
    space('gap', 'm'),
    enumOf('align', ['start', 'center', 'end', 'stretch', 'baseline'], { default: 'stretch' }),
    enumOf('justify', ['start', 'center', 'end', 'between', 'around'], { default: 'start' }),
    bool('wrap', { default: false }),
    space('padding', 'none'),
    bool('border', { default: false }),
    enumOf('maxWidth', MAX_WIDTHS, { default: 'full' }),
  ],
  render: {
    create(p) {
      const n = el('div', 'stack');
      n.dataset.direction = p.direction || 'column';
      n.style.gap = px(p.gap);
      n.style.padding = px(p.padding);
      n.style.alignItems = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' }[p.align] || 'stretch';
      n.style.justifyContent = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around' }[p.justify] || 'flex-start';
      if (p.wrap) n.style.flexWrap = 'wrap';
      if (p.border) n.classList.add('bordered');
      styleVars(n, p);
      return n;
    },
  },
  css: `
.stack { display: flex; flex-direction: column; }
.stack[data-direction="row"] { flex-direction: row; }
.stack.bordered { border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); border-radius: 12px; }
`,
});
