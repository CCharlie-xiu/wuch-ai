import { defineComponent, nodes, enumOf } from '../define.js';
import { el } from '../dom.js';

export default defineComponent({
  name: 'Card',
  group: 'Layout',
  description: '分组容器：极浅底色划出一块区域，不描边、不带投影',
  skeleton: { frame: true, lines: 3 },
  params: [
    nodes('children'),
    enumOf('variant', ['card', 'sunk', 'outline', 'ghost'], { default: 'card' }),
  ],
  render: {
    create(p) {
      const n = el('div', 'card');
      n.dataset.variant = p.variant || 'card';
      return n;
    },
  },
  css: `
/* 默认：极浅底色 + 无描边。块与块之间靠明度差 + 间距区分，不靠线。
   圆角比全局 token 收紧一档：20px 会显得像一张卡片，14px 更像一块区域 */
.card { background: var(--ui-band, rgba(17,24,39,.035)); border: 0; border-radius: 14px; padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
/* 下沉一档：需要「比块更内层」时用，比如块里的代码区、表格区 */
.card[data-variant="sunk"] { background: var(--ui-band-strong, rgba(17,24,39,.07)); }
/* 描边：只在底色用不了的地方（深色底、图片上）才用 */
.card[data-variant="outline"] { background: transparent; border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); }
.card[data-variant="ghost"] { background: transparent; padding: 0; }
/* 卡片里的表格 / 代码框不再自画外框：容器已经有底色，再套一层就是双层边界 */
.card .sheet, .card .code-block, .card .table-wrap { border: 0; border-radius: 0; background: transparent; }
`,
});
