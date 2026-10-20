// ─────────────────────────────────────────────────────────────────────────────
// 数据可视化的配色与色彩工具。
//
// 图表组件、仪表盘、刻度环、分段进度都从这里取色 —— 一份色板，全站图表同色。
// 组件「外壳」的颜色（边框、底色、文字）仍走宿主页面的 :root 变量；
// 这里只放**数据**用的颜色：它们要参与渐变与插值计算，必须是具体色值。
//
// 方向 004：组件不再带卡片底与投影，数据色仍是高饱和的参考稿色板。
//   色板是「靛 → 紫 → 琥珀 → 青 → 玫 → 绿」，柱状图走绿→青→靛的三段渐变，
//   仪表盘走绿→黄→橙→粉→紫的彩虹色带。
// ─────────────────────────────────────────────────────────────────────────────

/** 主色序列：藏青 / 灰紫 / 灰绿 / 灰青 / 赭石 / 灰玫。
 *  取自 UI-SPEC 「图表六色」：低饱和、明度有层次、色相分散 —— 远看是一片冷灰，
 *  近看才分得出是哪一条序列。高饱和调色板会把整页变成调色盘，也压不住站点主色（深松绿）。 */
export const PALETTE = ['#3f5d7d', '#6f6a86', '#5f7d6e', '#4a7a76', '#8a6f52', '#8a6272'];

/** 中性色：正文 / 次要 / 更次要（轴标签、图例）/ 细线 / 浅底 / 浮层底色 */
export const INK = { text: '#111827', muted: '#5b6472', dim: '#79828f', line: '#edf0f4', grid: '#f5f7fa', tip: '#111827' };

/** 由好到差的色带：仪表盘、分段进度用它表示「档位」。同样是低饱和，按语义从好到坏 */
export const RAMP = ['#3f7a5c', '#6f8f5c', '#a08b45', '#a5714a', '#a34f45'];

/** 单序列图表能挑的主色名（就是 PALETTE 的六个位置） */
export const TONES = ['blue', 'violet', 'green', 'teal', 'amber', 'pink'];

/** tone → 色板起点。不给或认不出就回到蓝色。 */
export const toneShift = (tone) => {
  const i = TONES.indexOf(tone);
  return i < 0 ? 0 : i;
};

// ─────────────────────────────────────────────────────────────────────────────
// 同色相明度阶梯
//
// 柱状图以前是多段彩虹渐变（紫底配橙顶、绿→青→靛），两段堆叠时像两块糖。
// 高质量数据图的做法是**一个色相、几档明度**：序列之间靠深浅区分，不靠换色相。
// 这样多序列堆叠仍然是一根「同一根柱子」，整体不花。
// ─────────────────────────────────────────────────────────────────────────────

/** #rrggbb → { h: 0–360, s: 0–1, l: 0–1 } */
export function toHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

/** { h, s, l } → #rrggbb */
export function fromHsl({ h, s, l }) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const to = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/**
 * 同色相明度阶梯：n 档，索引 0 最深（放堆叠最下面）、n-1 最浅。
 *
 * 以原色的明度为中心向两边展开，而不是从固定的 0.45 起 —— 否则深色调
 * （紫 / 青）会被压成墨块，浅色调（琥珀）又几乎不变。
 * 深档保持原饱和度，浅档顺手降一点：不然浅色会发荧光。
 */
export function toneScale(hex, n = 2) {
  const count = Math.max(1, Math.round(Number(n) || 1));
  if (count === 1) return [hex];
  const { h, s, l } = toHsl(hex);
  const start = Math.max(0.3, l - Math.min(0.1, 0.05 + 0.012 * (count - 1)));
  const end = Math.min(0.82, l + 0.16);
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    // 深档也退 8% 饱和（不然靛紫会发刺），浅档再继续退 —— 越浅越灰
    return fromHsl({ h, s: s * (0.92 - t * 0.14), l: start + (end - start) * t });
  });
}

/** 柱状图取色：tone 定色相，n 条序列 → n 档同色相明度 */
export const barScale = (tone, n = 2) => toneScale(PALETTE[toneShift(tone)], n);

/** #rrggbb + 透明度 → rgba() */
export const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** 两个十六进制色按 t∈[0,1] 线性插值 */
export function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const k = Math.max(0, Math.min(1, t));
  const ch = (sh) => Math.round(((pa >> sh) & 255) * (1 - k) + ((pb >> sh) & 255) * k);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** 从色带里按 t∈[0,1] 取色：先定位到相邻两色，再插值 */
export function rampAt(colors, t) {
  const x = Math.max(0, Math.min(1, t)) * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(x));
  return mix(colors[i], colors[i + 1], x - i);
}

/** 竖向渐变（ECharts 与 SVG 都认这个结构） */
export const vGradient = (top, bottom) => ({
  type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
  colorStops: [{ offset: 0, color: top }, { offset: 1, color: bottom }],
});

/** 竖向多段渐变：stops 从顶到底均匀铺开 */
export const vRamp = (stops) => ({
  type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
  colorStops: stops.map((c, i) => ({ offset: i / (stops.length - 1), color: c })),
});

/** 横向渐变 */
export const hGradient = (left, right) => ({
  type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
  colorStops: [{ offset: 0, color: left }, { offset: 1, color: right }],
});

/** 柱子的竖向渐变：顶部实、底部渐淡（现役柱状图用平涂，这个留给需要体积感的场景） */
export const barFill = (c, a = 0.42) => vGradient(rgba(c, 0.98), rgba(c, a));

/** 折线下方的面积渐变：从线色渐隐到透明 */
export const areaFill = (c, a = 0.26) => vGradient(rgba(c, a), rgba(c, 0));

/** 分段进度条的填充：浅色 → 本色，横向 */
export const segFill = (c) => hGradient(rgba(c, 0.55), c);

/** 同上，但给 CSS 用（DOM 组件的背景写不了渐变对象） */
export const cssSegFill = (c) => `linear-gradient(90deg, ${rgba(c, 0.5)}, ${c})`;
