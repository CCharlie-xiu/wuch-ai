// 瀑布流排布的不变量。
//
//   bun tests/layout.mjs
//
// 只测纯函数，不碰 DOM。页面上量矩形的那套在 layout-lab.html 里看。

import { packMasonry, packGreedy, packSticky, detectGaps, spanForWidth } from '../packages/catalog/src/layout/masonry.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
};

/** 固定种子的伪随机，保证每次跑的是同一组数据 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const overlap = (a, b) =>
  a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

// ── 1. 等高块：间距恒定、无空条 ───────────────────────────────────────────
console.log('\n1. 等高块');
{
  const items = Array.from({ length: 6 }, (_, i) => ({ id: i, span: 1, height: 100 }));
  const r = packMasonry(items, { cols: 3, gap: 12, width: 948 });
  ok(r.pageBottom === 212, `页底 = 两行 + 一道间距（实际 ${r.pageBottom}）`);
  ok(r.gaps.length === 0, `没有空条（实际 ${r.gaps.length} 条）`);
  ok(r.positions.every((p) => p.w === 308 || p.w === 308), '列宽 = (948 - 24) / 3');
}

// ── 2. 列内相邻两块：间距 ≥ gap，中间没别的块时必须正好等于 gap ──────────
console.log('\n2. 间距');
{
  const rand = rng(7);
  const items = Array.from({ length: 18 }, (_, i) => ({
    id: i,
    span: i % 7 === 3 ? 3 : 1,
    height: 60 + Math.round(rand() * 160),
  }));
  const r = packMasonry(items, { cols: 3, gap: 12, width: 948 });
  let bad = 0;
  for (let c = 0; c < 3; c++) {
    const col = r.positions.filter((p) => p.x <= c * 320 + 1 && p.x + p.w >= (c + 1) * 320 - 1).sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1];
      const cur = col[i];
      const between = r.positions.some(
        (p) => p !== prev && p !== cur && p.y >= prev.y + prev.h - 0.5 && p.y + p.h <= cur.y + 0.5
      );
      const d = cur.y - (prev.y + prev.h);
      if (d < 12 - 0.5) bad++;
      if (!between && Math.abs(d - 12) > 0.5) bad++;
    }
  }
  ok(bad === 0, `列内间距全部合规（异常 ${bad} 处）`);
  let hits = 0;
  for (let i = 0; i < r.positions.length; i++)
    for (let j = i + 1; j < r.positions.length; j++) if (overlap(r.positions[i], r.positions[j])) hits++;
  ok(hits === 0, `块之间不重叠（重叠 ${hits} 对）`);
}

// ── 3. 全宽块是屏障：后面的块不越过它的下沿 ──────────────────────────────
console.log('\n3. 屏障');
{
  const items = [
    { id: 'a', span: 1, height: 300 },
    { id: 'b', span: 1, height: 80 },
    { id: 'c', span: 1, height: 80 },
    { id: 'sect', span: 3, height: 30 },
    { id: 'd', span: 1, height: 100 },
  ];
  const r = packMasonry(items, { cols: 3, gap: 12, width: 948 });
  const bar = r.positions.find((p) => p.id === 'sect');
  const after = r.positions.filter((p) => ['d'].includes(p.id));
  ok(after.every((p) => p.y >= bar.y + bar.h), '屏障之后的块都在屏障下沿之下');
  ok(r.gaps.length > 0 && r.gaps[0].h > 0, `屏障前留下空条（${r.gaps[0].h}px）`);
}

// ── 4. 新算法不比旧算法高（同样输入，20 组随机） ──────────────────────────
console.log('\n4. 新旧对比');
{
  let better = 0;
  let worse = 0;
  let saved = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const rand = rng(seed * 31);
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      span: i % 6 === 2 ? 3 : 1,
      height: 70 + Math.round(rand() * 200),
    }));
    const a = packGreedy(items, { cols: 3, gap: 12, width: 948 });
    const b = packMasonry(items, { cols: 3, gap: 12, width: 948 });
    if (b.height < a.height - 0.5) {
      better++;
      saved += a.height - b.height;
    } else if (b.height > a.height + 0.5) worse++;
  }
  ok(worse === 0, `没有一组变高（变矮 ${better} 组，共省 ${saved}px）`);
  ok(better >= 10, `多数组变矮（${better}/20）`);
}

// ── 5. 补白：按块高比例给上限，超了不补 ──────────────────────────────────
console.log('\n5. 补白');
{
  const items = [
    { id: 'a', span: 1, height: 100 },
    { id: 'b', span: 1, height: 160 },
    { id: 'sect', span: 2, height: 30 },
  ];
  const raw = packMasonry(items, { cols: 2, gap: 12, width: 620 });
  const bar = raw.positions.find((p) => p.id === 'sect');
  const short = raw.positions.find((p) => p.id === 'a');
  const residual = bar.y - (short.y + short.h) - 12; // 扣掉那道正常间距
  ok(residual > 0, `屏障前有残差 ${residual}px`);

  const filled = packMasonry(items, { cols: 2, gap: 12, width: 620, absorb: { max: residual, min: residual } });
  ok(Math.abs(filled.positions.find((p) => p.id === 'a').h - short.h - residual) <= 1, '上限够时补到屏障');

  const capped = packMasonry(items, { cols: 2, gap: 12, width: 620, absorb: { max: residual - 1, min: residual - 1 } });
  ok(capped.positions.find((p) => p.id === 'a').h === short.h, '上限不够时不补');

  // 100px 的块，30% = 30px，残差 60px 补不动
  const ratio = packMasonry(items, { cols: 2, gap: 12, width: 620, absorb: { max: 96, ratio: 0.3 } });
  ok(ratio.positions.find((p) => p.id === 'a').h === short.h, '按块高 30% 给上限，大残差补不动');
}

// ── 6. 确定性：同样输入两次，结果逐块一致 ────────────────────────────────
console.log('\n6. 确定性');
{
  const rand = rng(99);
  const items = Array.from({ length: 16 }, (_, i) => ({ id: i, span: i % 5 === 1 ? 2 : 1, height: 50 + Math.round(rand() * 200) }));
  const a = packMasonry(items, { cols: 3, gap: 12, width: 948 });
  const b = packMasonry(items, { cols: 3, gap: 12, width: 948 });
  ok(JSON.stringify(a.positions) === JSON.stringify(b.positions), '两次排布完全一致');
}

// ── 7. 空条几何：detectGaps 的段数与每列占用一致 ─────────────────────────
console.log('\n7. 空条');
{
  const placed = [
    { id: 1, col: 0, span: 1, y: 0, h: 100 },
    { id: 2, col: 1, span: 1, y: 0, h: 300 },
    { id: 3, col: 0, span: 1, y: 112, h: 100 },
  ];
  const gaps = detectGaps(placed, 2, 300, 12);
  ok(gaps.length === 1 && gaps[0].col === 0 && gaps[0].y === 212 && gaps[0].h === 88, '第 0 列 212–300 是一段空条');
}

// ── 8. barrier:auto：屏障代价过大时降级 ──────────────────────────────────
console.log('\n8. 屏障降级');
{
  const items = [
    { id: 'tall', span: 1, height: 400 },
    { id: 'x', span: 1, height: 80 },
    { id: 'sect', span: 3, height: 30 },
    { id: 'y', span: 1, height: 80 },
  ];
  const keep = packMasonry(items, { cols: 3, gap: 12, width: 948, barrier: 'keep' });
  const auto = packMasonry(items, { cols: 3, gap: 12, width: 948, barrier: 'auto' });
  ok(keep.variant === 'keep', 'keep：保持整行标题');
  ok(auto.variant === 'demote', `auto：降级成普通块（省 ${keep.height - auto.height}px）`);
  ok(auto.height < keep.height, '降级后页高更小');
}

// ── 9. 分段拉齐：顺序不变，只拉末块，让每段各列底边对齐 ─────────────────
console.log('\n9. 分段拉齐');
{
  // 复现 Q3 截图：一段里左窄右宽，高矮差 275px
  const items = [
    { id: 'a', span: 1, height: 332 },
    { id: 'b', span: 2, height: 607 },
  ];
  const plain = packMasonry(items, { cols: 3, gap: 12, width: 948 });
  const eq = packMasonry(items, { cols: 3, gap: 12, width: 948, equalize: { ratio: 1, max: 400 } });
  const bottom = (r, id) => {
    const p = r.positions.find((x) => x.id === id);
    return p.y + p.h;
  };
  ok(bottom(plain, 'a') !== bottom(plain, 'b'), '不拉齐：两块底边不齐');
  ok(bottom(eq, 'a') === bottom(eq, 'b'), '拉齐：两块底边相等');
  ok(eq.height === plain.height, '拉齐不改页高');
  ok(eq.positions.map((p) => p.id).join() === plain.positions.map((p) => p.id).join(), '顺序不变');
  ok(eq.positions.every((p, i) => p.x === plain.positions[i].x && p.y === plain.positions[i].y), '位置不动，只改高度');

  // 上限：差额超过 ratio 时只拉到上限，不把小卡拉成长条
  const capped = packMasonry(items, { cols: 3, gap: 12, width: 948, equalize: { ratio: 0.3, max: 400, min: 0 } });
  const grown = capped.positions.find((p) => p.id === 'a').h - 332;
  ok(grown > 0 && grown <= 332 * 0.3 + 1, `超限只拉到上限（+${grown}px）`);

  // 分段独立：屏障前后的两段各自对齐，互不影响
  const two = packMasonry(
    [
      { id: 'a1', span: 1, height: 100 },
      { id: 'b1', span: 2, height: 200 },
      { id: 'h', span: 3, height: 26 },
      { id: 'a2', span: 1, height: 300 },
      { id: 'b2', span: 2, height: 150 },
    ],
    { cols: 3, gap: 12, width: 948, equalize: { ratio: 5, max: 1000 } }
  );
  const at = (id) => two.positions.find((p) => p.id === id);
  ok(at('a1').y + at('a1').h === at('b1').y + at('b1').h, '第一段对齐');
  ok(at('a2').y + at('a2').h === at('b2').y + at('b2').h, '第二段对齐');
}

// ── 10. 换宽度：高度随宽度变的块，可以挑更合适的跨列数 ───────────────────
console.log('\n10. 换宽度');
{
  // c 宽 1 列时 500 高，宽 2 列时只要 260 高（图表类）；a 占 1 列 260 高
  const items = [
    { id: 'a', span: 1, height: 260 },
    { id: 'c', span: 1, height: 500, alts: { 1: 500, 2: 260 } },
  ];
  const r = packMasonry(items, { cols: 3, gap: 12, width: 948 });
  const c = r.positions.find((p) => p.id === 'c');
  ok(c.span === 2 && c.h === 260, `c 改成跨 2 列，高 ${c.h}`);
  const fixed = packMasonry(items.map((it) => ({ ...it, alts: null })), { cols: 3, gap: 12, width: 948 });
  ok(r.height < fixed.height, `换宽度后页高更小（${fixed.height} → ${r.height}）`);
  const none = packMasonry([{ id: 'x', span: 1, height: 100 }], { cols: 3, gap: 12, width: 948 });
  ok(none.positions[0].span === 1, '没给 alts 的块宽度不变');
}

// ── 11. 粘性落位：流式期间块不换列 ──────────────────────────────────────
console.log('\n11. 粘性落位');
{
  const base = [
    { id: 0, span: 1, height: 100 },
    { id: 1, span: 1, height: 300 },
    { id: 2, span: 1, height: 100 },
    { id: 3, span: 1, height: 100 },
  ];
  const a = packSticky(base, { cols: 3, gap: 12, width: 948 });
  const cols1 = a.positions.map((p) => p.col);
  // 第 0 块长高、第 4 块新来：已有块的列号随 col 传入，必须不变
  const grown = base.map((it, i) => ({ ...it, col: cols1[i], height: i === 0 ? 500 : it.height }));
  grown.push({ id: 4, span: 1, height: 80 });
  const b = packSticky(grown, { cols: 3, gap: 12, width: 948 });
  ok(cols1.every((c, i) => b.positions[i].col === c), '已落位的块列号不变');
  ok(b.positions[4].col === 2 || b.positions[4].col === 1 || b.positions[4].col === 0, '新块有列号');
  ok(b.positions.length === 5, '新块被排进来');
  const same = packSticky(grown, { cols: 3, gap: 12, width: 948 });
  ok(JSON.stringify(same.positions) === JSON.stringify(b.positions), '确定性');
  const bad = packSticky([{ id: 0, span: 2, height: 50, col: 2 }], { cols: 3, gap: 12, width: 948 });
  ok(bad.positions[0].col + 2 <= 3, '列号越界当新块处理');
}

// ── 12. 24 栅格宽度 → 最小跨列数 ────────────────────────────────────────
console.log('\n12. 最小宽度（24 栅格）');
{
  ok(spanForWidth(0, 3) === 1, '没写 width：不额外约束');
  ok(spanForWidth(8, 3) === 1, '8/24 在 3 列里至少 1 列');
  ok(spanForWidth(9, 3) === 2, '超过 1/3 就抬到 2 列（向上取整，绝不比声明窄）');
  ok(spanForWidth(12, 3) === 2, '12/24 在 3 列里至少 2 列');
  ok(spanForWidth(16, 3) === 2, '16/24 在 3 列里至少 2 列');
  ok(spanForWidth(24, 3) === 3, '24/24 = 整行');
  ok(spanForWidth(12, 4) === 2 && spanForWidth(16, 4) === 3 && spanForWidth(24, 4) === 4, '4 列画布按比例抬到对应列数');
  ok(spanForWidth(24, 1) === 1 && spanForWidth(24, 6) === 6, '列数边界夹住');
}

// ── 13. 声明的 span / minSpan 是硬下限：收尾换宽度不能把表格压窄 ─────────
console.log('\n13. 不压窄已声明的宽度');
{
  // 表格声明 2 列；1 列宽时反而更矮（制造「压窄能省页高」的诱惑）
  const items = [
    { id: 'table', span: 2, minSpan: 2, height: 620, alts: { 1: 400, 2: 620, 3: 900 } },
    { id: 'kpi', span: 1, height: 120 },
  ];
  const r = packMasonry(items, { cols: 3, gap: 12, width: 948 });
  const table = r.positions.find((p) => p.id === 'table');
  ok(table.span === 2 && table.w === 628, `声明 2 列的表格没有被压成 1 列（实际 ${table.span} 列 / ${table.w}px）`);

  const grow = packMasonry(
    [
      { id: 'chart', span: 1, height: 300, alts: { 1: 300, 2: 260 } },
      { id: 'kpi', span: 1, height: 120 },
    ],
    { cols: 3, gap: 12, width: 948 }
  );
  ok(grow.positions.find((p) => p.id === 'chart').span === 2, '没有下限的块仍然可以在收尾时变宽');

  // 把「1 列」伪装成 0 高塞进 alts：归一化必须丢掉低于 minSpan 的候选，
  // 否则求解器一定会选它来压页高
  const trick = packMasonry(
    [
      { id: 'table', span: 1, minSpan: 2, height: 500, alts: { 1: 0, 2: 500, 3: 800 } },
      { id: 'kpi', span: 1, height: 120 },
    ],
    { cols: 3, gap: 12, width: 948 }
  );
  ok(trick.positions.find((p) => p.id === 'table').span >= 2, '低于 minSpan 的 alts 候选被过滤');
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 · ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
