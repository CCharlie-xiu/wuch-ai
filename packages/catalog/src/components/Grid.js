import { defineComponent, nodes, num, space } from '../define.js';
import { el } from '../dom.js';
import { packMasonry, packSticky, spanForWidth } from '../layout/masonry.js';

// ─────────────────────────────────────────────────────────────────────────────
// 瀑布流
//
// 为什么不用 CSS Grid 的 span 拼：
//   grid 是二维对齐的，块必须落在同一套行线上；跨列块（GridItem span 2）要占
//   两个连续空列，一旦某一列被矮块占住就找不到位置，`dense` 会把它往后塞，
//   中间留下整块空洞。取整（gridRowEnd span N）还会让每块下方多出 0–2px，
//   于是「每块之间间距都不一样」。
//
// 这里改成真正的瀑布流：绝对定位 + 每列独立往下堆。
//   · 间距恒等于 gap，没有取整误差
//   · 求解在 ../layout/masonry.js：整页一次算，目标是最小化页高与屏障残差
//   · 用 transform 定位（合成层，不改布局），容器高度由 JS 撑开
//   · 宽度变化 / 块高度变化都会重排：图表异步出图、图片加载、字体回流都跟得上
//
// 收尾（这一轮画完之后那一次）：
//   流式期间用便宜的束宽，块来了就落位，不做全局最优 —— 高度还在变，追最优没意义。
//   会话发 `openui:turn-end` 之后，等高度静默 220ms，再用完整束宽排一次，
//   把短列最后一块补到屏障（≤ ABSORB_MAX），这一步才是「块相互移动、空条收掉」。
//   同一个信号也控制过渡：流式期间关掉，收尾那一次打开，动起来才看得出来是收口。
// ─────────────────────────────────────────────────────────────────────────────
export const MIN_COL = 240;
export const DEFAULT_GAP = 12;
/** 收尾补白：短列最后一块最多向下补这么多（实际按块高 30% 取，夹在 [24, 上限]） */
export const ABSORB_MAX = 96;
/** 收尾拉齐：每段末块最多拉高 min(块高 × ratio, max)，超过的缺口靠换宽度解决 */
const STRETCH = { ratio: 0.85, max: 400, min: 48 };
const BEAM_FINAL = 32;
/** 收尾动画时长（要和下面 CSS 的 .38s 对上）；这段时间里块高在变，不当作内容变化 */
const SETTLE_ANIM_MS = 420;
const SETTLE_QUIET_MS = 220;
const SETTLE_RETRY = 6;

/** 活着的 Grid：会话只发一对 document 事件，由这里分发，避免每个 Grid 各挂一份监听 */
const LIVE = new Set();
let wired = false;

function wire() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  const fire = (kind) => {
    for (const g of [...LIVE]) {
      if (!g.el.isConnected) {
        LIVE.delete(g);
        continue;
      }
      g[kind]();
    }
  };
  document.addEventListener('openui:turn-start', () => fire('start'));
  document.addEventListener('openui:turn-end', () => fire('end'));
}

function masonry(grid, maxCols, gap) {
  let frame = 0;
  let settleTimer = 0;
  let applying = false;
  let lastW = -1;
  let streaming = true; // 收到 turn-start 置真；turn-end 且高度静默后置假
  let transitioned = false; // 过渡只开一次，之后的重排（图表出图、图片加载）继续用
  let animUntil = 0; // 收尾动画结束时刻：这之前块高在被动画改写，ResizeObserver 的回报不算数
  let lastCols = 0;
  const colOf = new WeakMap(); // 块 → 上次落的列：流式期间列号一旦定下就不再换
  const known = new Map(); // 子元素 → 上次量到的高度，用来过滤无意义的重排

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
    });
  };

  /** 收尾：这一轮画完之后，等高度静下来再排一次 */
  function armSettle(tries = 0) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      // 还有骨架就先等 —— 骨架高度不是最终高度，这时候排等于白排
      if (grid.querySelector('.ph') && tries < SETTLE_RETRY) return armSettle(tries + 1);
      streaming = false;
      schedule();
    }, SETTLE_QUIET_MS);
  }

  function layout() {
    if (applying) return;
    const w = Math.round(grid.clientWidth);
    if (!w) return;

    const items = Array.from(grid.children).filter((c) => c.nodeType === 1);
    if (!items.length) {
      grid.style.height = '0px';
      return;
    }

    const cols = Math.max(1, Math.min(maxCols, Math.floor((w + gap) / (MIN_COL + gap))));
    const colW = (w - gap * (cols - 1)) / cols;
    const final = !streaming;

    applying = true;
    try {
      // 收尾那一次：先记下「动画起点」（现在屏幕上的宽、高），量完再写回来，
      // 否则量高度时改的宽度会被当成起点，动画就没有了
      let fromW = null;
      let fromH = null;
      if (final) {
        fromW = items.map((c) => c.style.width);
        fromH = items.map((c) => c.offsetHeight);
        grid.classList.add('masonry-measuring');
      }

      // 声明的宽度是硬下限：
      //   span  = 当前画布跨几列（旧写法，仍然有效）
      //   width = 24 栅格里的最小宽度（8=1/3、12=1/2、16=2/3、24=整行）
      // 两者取更宽的那个。收尾求解只允许在这个下限之上变宽，不允许压窄 ——
      // 否则 span=2 的表格会被「省页高」压成 1 列。
      const minSpans = items.map((c) => {
        const declared = Math.max(1, Math.min(cols, Math.round(Number(c.dataset.span) || 1)));
        return Math.max(declared, spanForWidth(c.dataset.width, cols));
      });
      // 最小高度（px）：量高度前先挂上，自然高度就不会低于它
      const minHs = items.map((c) => Math.max(0, Math.round(Number(c.dataset.height) || 0)));

      // ① 先撤掉上一轮的补白，再定宽度：子元素要按最终宽度换行，量到的高度才是真的
      for (let i = 0; i < items.length; i++) {
        if (minHs[i]) items[i].style.minHeight = `${minHs[i]}px`;
        else if (items[i].style.minHeight) items[i].style.minHeight = '';
        const px = `${colW * minSpans[i] + gap * (minSpans[i] - 1)}px`;
        if (items[i].style.width !== px) items[i].style.width = px;
      }

      // ② 一次性读完所有高度：读写在两轮里做完，避免每块都强制一次同步布局
      const hs = items.map((c) => c.offsetHeight);

      // ②' 收尾时再量「换个宽度」的高度：整行块不动，其余块只在
      //     minSpan..cols-1 里试。低于声明宽度的列宽根本不量，求解器也就选不到。
      // 按列数分批：同一宽度下所有块一起改、一起读，每个宽度只触发一次回流
      const alts = final && cols > 2 ? items.map(() => ({})) : null;
      if (alts) {
        for (let s = 1; s < cols; s++) {
          if (minSpans.every((span) => span > s)) continue;
          const px = `${colW * s + gap * (s - 1)}px`;
          const pick = [];
          for (let i = 0; i < items.length; i++) {
            const base = minSpans[i];
            if (base >= cols || s < base) continue;
            if (base === s) alts[i][s] = hs[i];
            else {
              items[i].style.width = px;
              pick.push(i);
            }
          }
          for (const i of pick) alts[i][s] = items[i].offsetHeight;
          for (const i of pick) items[i].style.width = `${colW * minSpans[i] + gap * (minSpans[i] - 1)}px`;
        }
      }

      // ③ 求解
      //   流式：粘性落位。已经落过位的块列号不动，只重算 y；新块进最矮的列。
      //         块只会「长出来」，不会换列、不会互换，画面上没有跳动
      //   收尾：整页 beam 搜索 + 换宽度 + 分段拉齐，只做这一次
      const sameCols = cols === lastCols;
      const result = final
        ? packMasonry(
            items.map((c, i) => ({
              id: i,
              span: minSpans[i],
              minSpan: minSpans[i],
              height: hs[i],
              alts: alts && minSpans[i] < cols ? alts[i] : null,
            })),
            { cols, gap, width: w, beam: BEAM_FINAL, absorb: ABSORB_MAX, equalize: STRETCH }
          )
        : packSticky(
            items.map((c, i) => ({ id: i, span: minSpans[i], minSpan: minSpans[i], height: hs[i], col: sameCols ? colOf.get(c) : undefined })),
            { cols, gap, width: w }
          );
      lastCols = cols;

      if (final) {
        // 写回动画起点并提交一次样式，再打开过渡：这样宽度、高度、位置都从「现在」滑向目标
        for (let i = 0; i < items.length; i++) {
          items[i].style.width = fromW[i];
          items[i].style.minHeight = `${fromH[i]}px`;
        }
        void grid.offsetHeight;
        grid.classList.add('masonry-settled');
        grid.classList.remove('masonry-measuring');
        void grid.offsetHeight;
        transitioned = true;
      }

      // ④ 写目标：位置用 transform（合成层）；收尾时宽度、最小高度也一起过渡
      for (const p of result.positions) {
        const c = items[p.id];
        colOf.set(c, p.col);
        const next = `translate3d(${p.x}px, ${p.y}px, 0)`;
        if (c.style.transform !== next) c.style.transform = next;
        const natural = alts && alts[p.id][p.span] != null ? alts[p.id][p.span] : hs[p.id];
        // 目标最小高度 = max(模型声明的高度, 拉齐后的高度)。没声明、也没拉伸就交还给内容撑高
        const floorH = minHs[p.id] || 0;
        const targetH = Math.max(floorH, p.h > natural + 0.5 ? p.h : 0);
        if (final) {
          const wpx = `${p.w}px`;
          if (c.style.width !== wpx) c.style.width = wpx;
          c.style.minHeight = targetH ? `${targetH}px` : '0px';
        } else if (targetH) {
          c.style.minHeight = `${targetH}px`;
        }
        c.classList.add('grid-placed');
        // 记成「应用之后的高度」：不记的话 ResizeObserver 会当成内容变化，来回重排
        known.set(c, Math.max(natural, p.h));
      }

      if (final) {
        // 动画期间块高被过渡改写，ResizeObserver 的回报不是内容变化，别拿去重排
        animUntil = performance.now() + SETTLE_ANIM_MS;
      }

      const h = `${result.pageBottom}px`;
      if (grid.style.height !== h) grid.style.height = h;
      grid.classList.add('masonry-ready');
      lastW = w;
    } finally {
      applying = false;
    }
  }

  // 容器宽度变化 → 重排。只看宽度：高度是我们自己写的，观察高度会自触发。
  new ResizeObserver(() => {
    const w = Math.round(grid.clientWidth);
    if (w === lastW) return;
    schedule();
  }).observe(grid);

  // 块自身高度变化 → 重排。图表异步出图、图片加载完、字体回流都走这里。
  const childRO = new ResizeObserver((entries) => {
    if (applying || performance.now() < animUntil) return;
    let dirty = false;
    for (const e of entries) {
      const h = Math.round(e.contentRect.height);
      if (known.get(e.target) === h) continue;
      known.set(e.target, h);
      dirty = true;
    }
    if (dirty) schedule();
  });

  new MutationObserver((records) => {
    for (const r of records) {
      // 骨架被成品替换（同一位置删一个、加一个）：新块沿用旧块的列，替换时不跳列
      const gone = Array.from(r.removedNodes).filter((x) => x.nodeType === 1);
      const born = Array.from(r.addedNodes).filter((x) => x.nodeType === 1);
      for (let i = 0; i < Math.min(gone.length, born.length); i++) {
        const col = colOf.get(gone[i]);
        if (col != null) colOf.set(born[i], col);
      }
      for (const x of r.addedNodes) {
        if (x.nodeType === 1) childRO.observe(x);
      }
      for (const x of r.removedNodes) {
        if (x.nodeType === 1) {
          childRO.unobserve(x);
          known.delete(x);
        }
      }
    }
    schedule();
  }).observe(grid, { childList: true });

  wire();
  const entry = {
    el: grid,
    start() {
      streaming = true;
      clearTimeout(settleTimer);
      // 新一轮还在长，先把过渡关掉：否则每来一块整页抖一次
      if (transitioned) {
        grid.classList.remove('masonry-settled');
        transitioned = false;
      }
    },
    end() {
      armSettle();
    },
  };
  LIVE.add(entry);

  schedule();
  // 字体换了行宽会变，高度得重算一次
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
}

export default defineComponent({
  name: 'Grid',
  group: 'Layout',
  description: '瀑布流模块墙：子块按列铺开、各自按高度往下落，左右自动咬合；高矮不齐不用凑，宽内容用 GridItem 的 span / width 声明最小宽度',
  params: [
    nodes('children'),
    num('columns', { default: 3 }),
    space('gap', 'm'),
  ],
  render: {
    create(p) {
      const n = el('div', 'grid');
      const maxCols = Math.max(1, Math.min(6, Math.round(Number(p.columns) || 3)));
      const gap = typeof p.gap === 'number' ? p.gap : DEFAULT_GAP;
      n.style.setProperty('--grid-gap', gap + 'px');
      if (typeof ResizeObserver !== 'undefined') masonry(n, maxCols, gap);
      return n;
    },
  },
  css: `
.grid { position: relative; width: 100%; min-height: 1px; }
/* 兜底：没跑 JS（或环境不支持 ResizeObserver）时纵向排列，块之间保持同样的间距 */
.grid:not(.masonry-ready) > * + * { margin-top: var(--grid-gap, 12px); }
/* 布局由 JS 接管。ready 之前不显示，避免第一帧全部堆在左上角 */
.grid.masonry-ready > * {
  position: absolute; top: 0; left: 0; margin: 0;
  will-change: transform;
}
.grid.masonry-ready > * { opacity: 0; }
.grid.masonry-ready > .grid-placed { opacity: 1; }
/* 收尾那一次才开过渡：流式期间块直接出现在最终位置，不滑 */
.grid.masonry-settled > * {
  transition: transform .38s cubic-bezier(.22, 1, .36, 1), width .38s cubic-bezier(.22, 1, .36, 1),
    min-height .38s cubic-bezier(.22, 1, .36, 1), opacity .2s ease;
}
/* 收尾量尺寸的那一瞬间关掉过渡：量到的必须是目标宽度下的真实高度，不是动画中途的值 */
.grid.masonry-measuring > * { transition: none !important; }
/* 瀑布流里的块平权：统一 1px 边框就够分层，不要再给卡片单独加阴影 ——
   块高矮不一，阴影会让矮块显得更浮，节奏反而乱。 */
.grid > .metric, .grid > .grid-item > .metric { min-width: 0; }
@media (prefers-reduced-motion: reduce) {
  .grid.masonry-settled > * { transition: none; }
}
`,
});
