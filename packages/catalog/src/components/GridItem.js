import { defineComponent, nodes, num } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'GridItem',
  group: 'Layout',
  description:
    'Grid 里的一块。span 是当前画布跨几列；width 是 24 栅格里的最小宽度（8=1/3、12=1/2、16=2/3、24=整行），排版只会更宽不会压窄；height 是最小高度 px',
  params: [
    nodes('children'),
    num('span', { default: 1 }),
    num('width'),
    num('height'),
  ],
  render: {
    create(p) {
      const n = el('div', 'grid-item');
      n.dataset.span = String(Math.max(1, Math.min(6, Math.round(Number(p.span) || 1))));
      const width = Math.max(0, Math.min(24, Math.round(Number(p.width) || 0)));
      if (width) n.dataset.width = String(width);
      const height = Math.max(0, Math.min(2000, Math.round(Number(p.height) || 0)));
      if (height) {
        n.dataset.height = String(height);
        // 没有 Grid（或 JS 没跑起来）时也保底
        n.style.minHeight = `${height}px`;
      }
      return n;
    },
  },
  css: `
.grid-item { display: flex; flex-direction: column; gap: 12px; }
/* 收尾拉齐会给外层加 min-height：里面唯一的卡片要跟着撑满，否则可见的底边还是不齐 */
.grid-item > .card:only-child { flex: 1 1 auto; }
`,
});
