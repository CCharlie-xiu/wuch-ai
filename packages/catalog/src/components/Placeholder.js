import { defineComponent, str } from '../define.js';
import { el } from '../dom.js';

// 流式中还没写到的变量、写到一半的组件，编译器在它们的位置放一个 Placeholder，
// 形状取自目标组件的 skeleton 声明（编译期并进 props），尽量和成品等大，成品出来时界面不跳。
// 不知道是什么组件时（变量还没开始写）按一块两行文字占位；放在 Grid 里时按卡片占位。
export default defineComponent({
  name: 'Placeholder',
  group: 'Feedback',
  description: '流式占位骨架（编译器生成）',
  internal: true,
  params: [str('of')],
  render: {
    create(p) {
      const n = el('div', 'ph');
      if (p.of) n.dataset.of = p.of;
      if (p.frame) n.classList.add('frame');
      if (p.inline) {
        n.classList.add('inline');
        n.style.width = (p.w || 96) + 'px';
        n.style.height = (p.h || 34) + 'px';
        return n;
      }
      if (p.h || p.ratio) {
        const b = el('div', 'ph-block');
        if (p.h) b.style.height = p.h + 'px';
        if (p.ratio) b.style.aspectRatio = p.ratio;
        n.appendChild(b);
      }
      const lines = p.lines ?? (p.h || p.ratio ? 0 : 2);
      for (let i = 0; i < lines; i++) n.appendChild(el('div', 'ph-line'));
      return n;
    },
  },
  markdown: () => '',
  css: `
.ph { display: flex; flex-direction: column; gap: 8px; min-width: 0; animation: ph-in .2s ease-out; }
/* 骨架是「还没到的块」：用块底色占位，不描边 —— 描边会让加载中的页面出现一堆空框 */
.ph.frame { border: 0; border-radius: 14px; padding: 14px; background: var(--ui-band, rgba(17,24,39,.035)); }
.ph.inline { display: inline-block; border-radius: 9px; }
.ph-block, .ph-line, .ph.inline { background: linear-gradient(100deg, #f1f1f3 30%, #e8e8ec 50%, #f1f1f3 70%); background-size: 220% 100%; animation: shimmer 1.4s linear infinite; }
.ph-block { width: 100%; border-radius: 10px; }
.ph-line { height: 11px; border-radius: 999px; }
.ph-line:first-child:not(:only-child) { width: 45%; height: 13px; }
.ph-line:last-child:not(:only-child) { width: 70%; }
.grid > .ph:not([data-of]), .grid-item > .ph:not([data-of]) { border: 0; border-radius: 14px; padding: 14px; background: var(--ui-band, rgba(17,24,39,.035)); min-height: 120px; }
@keyframes ph-in { from { opacity: 0; } to { opacity: 1; } }
`,
});
