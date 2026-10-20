// ─────────────────────────────────────────────────────────────────────────────
// 瀑布流排布（纯函数，不碰 DOM）
//
// 输入：按阅读顺序排好的块 [{ id, span, height }]
// 输出：每块的落位 [{ id, col, span, x, y, w, h }] + 页高 + 空条统计
//
// 与「每次放进最矮的列」的区别：
//   · 整页一次求解，目标是最小化页高。页高最小 = 底部最平 = 空白最少
//   · 全宽块（分节标题）是硬屏障：它把每一列都推到自己的下沿，后面的块越不过去。
//     屏障前那一段「列高不齐」的空条，是屏障的代价，不是算法的错
//   · 代价用两项：抬升（后块落到前块上方多少）+ 换列距离。都只做小权重，
//     真正的主项是页高
//
// 收尾三步：
//   1) 求解：束搜索（beam）替代贪心，选出页高最小的列分配
//   2) 补白：屏障前残差 ≤ limit 的列，把该列最后一块向下补到屏障
//   3) 诊断：把每个空条量出来（宽 × 高），交给页面决定要不要再处理
// ─────────────────────────────────────────────────────────────────────────────

const EPS = 0.5;

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function maxOf(arr) {
  let m = 0;
  for (const v of arr) if (v > m) m = v;
  return m;
}

/**
 * 状态打分：已花代价 + 页高 + 列间落差
 *
 * 只压页高不够。页高 = 最高的那一列，剩下两列落后多少它不管 ——
 * 结果就是「块全挤进前两列、第三列空一大截，页高却没变」。
 * 落差（最高列 - 每列）之和，量的是这块空白有多大。
 */
function scoreOf(st, wasteWeight) {
  const m = maxOf(st.y);
  let lag = 0;
  for (const v of st.y) lag += m - v;
  return st.cost + m + lag * wasteWeight;
}

/** 24 栅格的宽度单位 → 当前列数下至少要跨几列（向上取整，保证不会比声明的窄） */
export const WIDTH_UNITS = 24;
export function spanForWidth(width, cols) {
  const n = Math.max(1, Math.min(12, Math.round(Number(cols) || 1)));
  const units = Math.max(0, Math.min(WIDTH_UNITS, Number(width) || 0));
  if (!units) return 1;
  return Math.max(1, Math.min(n, Math.ceil((units / WIDTH_UNITS) * n - 1e-6)));
}

/**
 * 归一化：span 夹到 1..cols，高度不能为负。
 *
 * minSpan 是硬下限：模型在 GridItem 上声明的宽度（span / width 24 栅格）
 * 只允许被排得更宽，不允许被「为了压页高」压窄。以前 alts 从 1 开始量，
 * 求解器会把 span=2 的表格缩成 1 列 —— 表格被挤成窄条就是这么来的。
 */
function normalize(items, cols) {
  return items.map((it, i) => {
    const requested = Math.max(1, Math.min(cols, Math.round(Number(it.span) || 1)));
    const minSpan = Math.max(requested, Math.min(cols, Math.round(Number(it.minSpan != null ? it.minSpan : requested) || requested)));
    const span = Math.max(requested, minSpan);
    // alts：{ 跨列数: 该宽度下量到的高度 }。给了就表示这块「可以换宽度」，
    // 求解器在这些跨列数里挑；没给就是定宽块。低于 minSpan 的宽度直接丢掉。
    let alts = null;
    if (it.alts && typeof it.alts === 'object') {
      alts = {};
      for (const [k, v] of Object.entries(it.alts)) {
        const s = Math.round(Number(k));
        const h = Number(v);
        if (s >= minSpan && s <= cols && Number.isFinite(h) && h >= 0) alts[s] = h;
      }
      if (!Object.keys(alts).length) alts = null;
    }
    const height = Math.max(0, Number(it.height != null ? it.height : alts && alts[span]) || 0);
    if (alts && alts[span] == null) alts[span] = height;
    return { id: it.id != null ? it.id : i, span, minSpan, height, alts };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 求解器：束搜索
//
// 状态 = 每列的当前下沿 + 上一块的 y 与列号。
// 动作 = 这一块从哪一列开始（span 决定占用几列）。
// 因为按顺序逐块放，同一列里的相对顺序天然保序；跨列的顺序可以乱 —— 这正是瀑布流。
// ─────────────────────────────────────────────────────────────────────────────
function packOnce(list, cols, gap, opts) {
  const beam = Math.max(1, opts.beam || 32);
  const upWeight = opts.upWeight != null ? opts.upWeight : 0.05;
  const switchWeight = opts.switchWeight != null ? opts.switchWeight : 1;
  // 屏障残差是最显眼的空白，权重给得比页高还重：宁可整页高一点，也不要一条大空带
  const barrierWeight = opts.barrierWeight != null ? opts.barrierWeight : 1.2;
  // 换宽度的代价：和「少拉伸多少像素」同一把尺子。30 ≈ 为省 25px 拉伸才值得改一次宽
  const spanWeight = opts.spanWeight != null ? opts.spanWeight : 30;

  let states = [{ y: new Array(cols).fill(0), lastY: 0, lastCol: 0, cost: 0, placed: [] }];

  for (const it of list) {
    const next = [];
    const spanList = it.alts ? Object.keys(it.alts).map(Number) : [it.span];
    for (const st of states) {
      for (const span of spanList) {
        const h = it.alts ? it.alts[span] : it.height;
        const respan = Math.abs(span - it.span) * spanWeight;
        for (let s = 0; s + span <= cols; s++) {
          let y = 0;
          for (let k = 0; k < span; k++) if (st.y[s + k] > y) y = st.y[s + k];
          const y2 = st.y.slice();
          const top = y + h + gap;
          for (let k = 0; k < span; k++) y2[s + k] = top;
          const up = Math.max(0, st.lastY - y);
          // 全宽块落下的瞬间，短列上方那段就是空条，直接记进代价
          let waste = 0;
          if (span >= cols) for (let k = 0; k < cols; k++) waste += Math.max(0, y - st.y[k]);
          next.push({
            y: y2,
            lastY: y,
            lastCol: s,
            cost: st.cost + up * upWeight + Math.abs(s - st.lastCol) * switchWeight + waste * barrierWeight + respan,
            placed: st.placed.concat([{ id: it.id, col: s, span, y, h }]),
          });
        }
      }
    }
    // 剪枝排序：已花代价 + 当前最高列（页高的下界）。落差只给半权，
    // 因为列还没长完，眼下的落差可能被后面的块填回来
    next.sort((a, b) => scoreOf(a, 0.5) - scoreOf(b, 0.5) || a.lastCol - b.lastCol);
    states = [];
    const seen = new Set();
    for (const st of next) {
      // 同一下沿形状 + 同一上一块位置 = 等价状态，留代价低的那条
      const key = st.y.map((v) => Math.round(v / 4)).join(',') + '|' + Math.round(st.lastY / 4);
      if (seen.has(key)) continue;
      seen.add(key);
      states.push(st);
      if (states.length >= beam) break;
    }
  }

  let best = states[0];
  for (const st of states) {
    if (scoreOf(st, 1) < scoreOf(best, 1) - EPS) best = st;
  }
  return best.placed;
}

/**
 * 粘性落位：流式期间用。
 *
 * 已经有列号的块列号不动，只重算 y（上面的块长高，下面的跟着往下顺）；
 * 没有列号的新块按「最矮的列」落位。块不会换列、不会互换，所以画面上只有「长出来」，
 * 没有「跳来跳去」。整页最优解留到收尾那一次。
 *
 * items: [{ id, span, height, col? }]，col 不合法（越界）就当新块处理
 */
export function packSticky(items, options = {}) {
  const cols = clampInt(options.cols != null ? options.cols : 3, 1, 12);
  const gap = Math.max(0, Number(options.gap != null ? options.gap : 12));
  const list = normalize(items, cols);
  const bottom = new Array(cols).fill(0);
  const placed = [];
  list.forEach((it, i) => {
    const want = items[i] && items[i].col;
    let col = Number.isInteger(want) && want >= 0 && want + it.span <= cols ? want : -1;
    const topOf = (s) => {
      let y = 0;
      for (let k = 0; k < it.span; k++) if (bottom[s + k] > y) y = bottom[s + k];
      return y;
    };
    if (col < 0) {
      let bestY = Infinity;
      col = 0;
      for (let s = 0; s + it.span <= cols; s++) {
        const y = topOf(s);
        if (y < bestY - EPS) {
          bestY = y;
          col = s;
        }
      }
    }
    const y = topOf(col);
    for (let k = 0; k < it.span; k++) bottom[col + k] = y + it.height + gap;
    placed.push({ id: it.id, col, span: it.span, y, h: it.height });
  });
  return finish(placed, cols, gap, { width: options.width });
}

/** 现役算法（Grid.js 里的贪心），留作对照与回归基线 */
export function packGreedy(items, options = {}) {
  const cols = clampInt(options.cols != null ? options.cols : 3, 1, 12);
  const gap = Math.max(0, Number(options.gap != null ? options.gap : 12));
  const list = normalize(items, cols);
  const colY = new Array(cols).fill(0);
  const placed = [];
  for (const it of list) {
    let best = 0;
    let bestY = Infinity;
    for (let s = 0; s + it.span <= cols; s++) {
      let y = 0;
      for (let k = 0; k < it.span; k++) if (colY[s + k] > y) y = colY[s + k];
      if (y < bestY - EPS) {
        bestY = y;
        best = s;
      }
    }
    if (!Number.isFinite(bestY)) bestY = 0;
    for (let k = 0; k < it.span; k++) colY[best + k] = bestY + it.height + gap;
    placed.push({ id: it.id, col: best, span: it.span, y: bestY, h: it.height });
  }
  return finish(placed, cols, gap, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// 补白：屏障（全宽块）前面，把短列的最后一块向下补到屏障
//
// 补多少有上限：一块 140px 的指标卡拉到 230px，内容全挤在上半截 ——
// 那不是「补白」，是把空白换成了变形。上限按块高比例给（默认 30%），
// 再夹在 [min, max] 之间。跨列块要补，得它覆盖的每一列残差都一样，
// 否则补完反而把另一列顶出新的缝。
// ─────────────────────────────────────────────────────────────────────────────
function absorbAtBarriers(placed, cols, gap, opts) {
  const max = Number(opts.max) || 0;
  if (!(max > 0)) return [];
  const min = opts.min != null ? Number(opts.min) : 24;
  const ratio = opts.ratio != null ? Number(opts.ratio) : 0.3;
  const limitFor = (item) => Math.min(max, Math.max(min, item.h * ratio));

  const bottom = new Array(cols).fill(0);
  const lastIn = new Array(cols).fill(null);
  const extra = [];
  for (const p of placed) {
    if (p.span >= cols) {
      // 残差要扣掉那道正常间距：列底到屏障之间本来就该留一个 gap
      const residual = (c) => p.y - bottom[c] - gap;
      const done = new Set();
      for (let c = 0; c < cols; c++) {
        const item = lastIn[c];
        if (!item || done.has(item)) continue;
        const d = residual(c);
        if (d <= EPS || d > limitFor(item)) continue;
        // 跨列块：它覆盖的每一列都得空出同样多，才值得整块下延
        let same = true;
        for (let k = 0; k < item.span; k++) if (Math.abs(residual(item.col + k) - d) > 1) same = false;
        if (!same) continue;
        item.h += d;
        done.add(item);
        extra.push({ id: item.id, extra: Math.round(d) });
        for (let k = 0; k < item.span; k++) bottom[item.col + k] = p.y;
      }
    }
    for (let k = 0; k < p.span; k++) {
      const c = p.col + k;
      bottom[c] = Math.max(bottom[c], p.y + p.h);
      lastIn[c] = p;
    }
  }
  return extra;
}

// ─────────────────────────────────────────────────────────────────────────────
// 分段拉齐：每一段（两道屏障之间 / 末段）把各列底边拉到同一条线
//
// 不换顺序、不挪位置：只把每列「最后一块」向下拉高，补上它和本段最低列的差。
// 最后一块下面没有别的块，拉高不会顶到谁，所有 y 都不用动。
//   · 跨列块要拉，得它覆盖的每一列它都是最后一块；差额取各列差额里最小的一个，
//     否则会越过相邻列的底边
//   · 拉伸量有上限（块高的 ratio，且不超过 max）：超了就只拉到上限，
//     剩下的缺口交给「换宽度」那一层去解决，不把一张小卡拉成长条
//   · 一轮拉完会改变各列底边，再扫几轮直到不再变化
// ─────────────────────────────────────────────────────────────────────────────
function equalizeSegments(placed, cols, opts) {
  const ratio = opts.ratio != null ? Number(opts.ratio) : 0.85;
  const max = opts.max != null ? Number(opts.max) : 400;
  const floor = opts.min != null ? Number(opts.min) : 48;
  if (!(ratio > 0) || !(max > 0)) return [];
  // 按拉伸前的高度算上限；item.h 会被改写，不能在拉的过程中读它
  const base = new Map(placed.map((p) => [p.id, p.h]));
  const limitFor = (item) => Math.min(max, Math.max(floor, base.get(item.id) * ratio));

  const segments = [];
  let cur = [];
  for (const p of placed) {
    if (p.span >= cols) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length) segments.push(cur);

  const total = new Map();
  for (const seg of segments) {
    for (let pass = 0; pass < 4; pass++) {
      const bottom = new Array(cols).fill(-Infinity);
      const lastIn = new Array(cols).fill(null);
      for (const p of seg) {
        for (let k = 0; k < p.span; k++) {
          const c = p.col + k;
          if (p.y + p.h > bottom[c]) {
            bottom[c] = p.y + p.h;
            lastIn[c] = p;
          }
        }
      }
      let target = -Infinity;
      for (let c = 0; c < cols; c++) if (bottom[c] > target) target = bottom[c];
      let changed = false;
      for (let c = 0; c < cols; c++) {
        const item = lastIn[c];
        if (!item || item.col !== c) continue; // 跨列块只在它的起始列处理一次
        let d = Infinity;
        let sole = true;
        for (let k = 0; k < item.span; k++) {
          if (lastIn[item.col + k] !== item) sole = false;
          d = Math.min(d, target - bottom[item.col + k]);
        }
        if (!sole || d <= EPS) continue;
        // 上限按「累计」算：多扫几轮不能把同一块越拉越长
        d = Math.min(d, limitFor(item) - (total.get(item.id) || 0));
        if (d <= EPS) continue;
        item.h += d;
        total.set(item.id, (total.get(item.id) || 0) + d);
        changed = true;
      }
      if (!changed) break;
    }
  }
  return [...total].map(([id, extra]) => ({ id, extra: Math.round(extra) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 空条：每列没被占住的那几段
//
// 瀑布流里所有块都是「贴着列往下堆」，列内不会出现缝。真正的空白只有一种：
// 某一列已经空了，旁边那列还在长 —— 视觉上就是一条竖着的空带。
// 全宽块会把这条空带钉死（后面的块越不过屏障），所以它才是「大片空白」的来源。
// ─────────────────────────────────────────────────────────────────────────────
export function detectGaps(placed, cols, pageBottom, gap = 0, barrierYs = null) {
  const spans = Array.from({ length: cols }, () => []);
  for (const p of placed) {
    for (let k = 0; k < p.span; k++) {
      const c = p.col + k;
      if (c < cols) spans[c].push([p.y, p.y + p.h]);
    }
  }
  // 块与块之间那道间距是设计好的，不算空条
  const floor = Math.max(0, gap) + 1;
  const gaps = [];
  const kindOf = (end) => {
    if (Math.abs(end - pageBottom) <= 1) return 'tail';
    if (barrierYs && barrierYs.has(Math.round(end))) return 'barrier';
    return 'inner';
  };
  for (let c = 0; c < cols; c++) {
    spans[c].sort((a, b) => a[0] - b[0]);
    let y = 0;
    for (const [a, b] of spans[c]) {
      if (a - y > floor) gaps.push({ col: c, y, h: a - y, kind: kindOf(a) });
      y = Math.max(y, b);
    }
    if (pageBottom - y > floor) gaps.push({ col: c, y, h: pageBottom - y, kind: kindOf(pageBottom) });
  }
  gaps.sort((a, b) => b.h - a.h);
  return gaps;
}

function finish(placed, cols, gap, options) {
  const width = Math.max(0, Number(options.width) || 0);
  const absorb = options.absorb;
  const extra = absorbAtBarriers(placed, cols, gap, typeof absorb === 'number' ? { max: absorb } : absorb || {});
  // 分段拉齐：true 用默认上限，对象可调 { ratio, max, min }
  const eq = options.equalize;
  const stretched = eq ? equalizeSegments(placed, cols, eq === true ? {} : eq) : [];

  const colW = width ? (width - gap * (cols - 1)) / cols : 0;
  const positions = placed.map((p) => ({
    id: p.id,
    col: p.col,
    span: p.span,
    x: width ? Math.round(p.col * (colW + gap)) : p.col,
    y: Math.round(p.y),
    w: width ? Math.round(colW * p.span + gap * (p.span - 1)) : p.span,
    h: Math.round(p.h),
  }));

  let pageBottom = 0;
  for (const p of placed) pageBottom = Math.max(pageBottom, p.y + p.h);
  const barrierYs = new Set(placed.filter((p) => p.span >= cols).map((p) => Math.round(p.y)));
  const gaps = detectGaps(placed, cols, pageBottom, gap, barrierYs);
  const waste = gaps.reduce((n, g) => n + g.h * colW, 0);
  // 报数时扣掉那道正常间距：读者看到的是「多出来的空白」，不是几何上的空区间
  const maxOfKind = (kind) =>
    Math.round(gaps.filter((g) => g.kind === kind).reduce((m, g) => Math.max(m, g.h - (kind === 'tail' ? 0 : gap)), 0));

  return {
    positions,
    cols,
    gap,
    width,
    colW,
    // height 与 pageBottom 同义：容器高度就该是「最底一块的下沿」，不含尾部间距
    height: Math.round(pageBottom),
    pageBottom: Math.round(pageBottom),
    gaps,
    maxGap: gaps.length ? Math.round(gaps[0].h) : 0,
    barrierGap: maxOfKind('barrier'),
    tailGap: maxOfKind('tail'),
    waste: Math.round(waste),
    wasteRatio: width && pageBottom ? waste / (width * pageBottom) : 0,
    absorbed: extra,
    stretched,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 对外入口
//
// options:
//   cols     列数
//   gap      块间距（px）
//   width    画布宽度（px），给了才有 x/w
//   absorb   补白上限，0 = 不补。可传数字（只给上限）或 { max, min, ratio }
//            默认按块高 30% 补，夹在 [24, max] 之间
//   barrier  'keep' 全宽块永远当屏障（默认）
//            'auto' 屏障代价超过 demoteOver 时，把全宽块降级成普通块再排一遍
//   beam     束宽，默认 32
// ─────────────────────────────────────────────────────────────────────────────
export function packMasonry(items, options = {}) {
  const cols = clampInt(options.cols != null ? options.cols : 3, 1, 12);
  const gap = Math.max(0, Number(options.gap != null ? options.gap : 12));
  const list = normalize(items, cols);
  const base = {
    beam: options.beam,
    upWeight: options.upWeight,
    switchWeight: options.switchWeight,
    barrierWeight: options.barrierWeight,
    width: options.width,
    absorb: options.absorb,
    equalize: options.equalize,
    spanWeight: options.spanWeight,
  };

  const kept = packOnce(list, cols, gap, base);
  const keptOut = finish(kept, cols, gap, base);

  const policy = options.barrier || 'keep';
  if (policy !== 'auto' || cols < 2 || !list.some((it) => it.span >= cols)) {
    return { ...keptOut, variant: 'keep', compared: null };
  }

  const demoteOver = Number(options.demoteOver != null ? options.demoteOver : 48);
  const demoted = packOnce(list.map((it) => (it.span >= cols ? { ...it, span: 1 } : it)), cols, gap, base);
  const demotedOut = finish(demoted, cols, gap, base);

  // 降级只在「明显更矮」时才做：为几十像素牺牲整行标题不值得
  const useDemote = keptOut.height - demotedOut.height > demoteOver;
  return {
    ...(useDemote ? demotedOut : keptOut),
    variant: useDemote ? 'demote' : 'keep',
    compared: { keep: keptOut.height, demote: demotedOut.height },
  };
}
