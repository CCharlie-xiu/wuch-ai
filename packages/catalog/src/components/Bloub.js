// ─────────────────────────────────────────────────────────────────────────────
// Bloub —— 会呼吸变形的黑色 blob 头像。
//
// 取材自 x.ai 机器人头像那类「纯 SVG、无动画库、在多个形状间平滑变形」的做法，
// 但形状是本项目自己生成的（8 个控制点的平滑闭合曲线，命令结构一致），
// 用 SMIL <animate> 在它们之间插值 —— 没有一行 JS 运行时，没有动画库。
//
// 形状在模块加载时算好（纯数学，不碰 document），渲染时只挂 DOM。
// ─────────────────────────────────────────────────────────────────────────────

import { defineComponent, enumOf, num } from '../define.js';
import { svgEl } from '../dom.js';

const CX = 100;
const CY = 100;
const R = 64; // 基准半径，留出呼吸余量，形状最大约 1.2R 仍落在 200 视口内
const N = 8; // 控制点数，所有形状一致 —— 这是 SMIL 能平滑插值的前提
const ANG = Array.from({ length: N }, (_, i) => (i / N) * Math.PI * 2 - Math.PI / 2);

/** 给定每个控制点的半径倍率，生成一条 Catmull-Rom → 三次贝塞尔 的平滑闭合路径 */
function blobPath(radii) {
  const pts = radii.map((k, i) => [CX + Math.cos(ANG[i]) * R * k, CY + Math.sin(ANG[i]) * R * k]);
  const at = (i) => pts[(i % N + N) % N];
  const f = (v) => v.toFixed(2);
  let d = `M ${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let i = 0; i < N; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${f(c1x)} ${f(c1y)}, ${f(c2x)} ${f(c2y)}, ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d} Z`;
}

// 六组半径扰动（0.85–1.2），确定性、可复现；形状之间的差异制造「变形」感
const RADII = [
  [1.0, 1.1, 0.95, 1.15, 1.0, 0.9, 1.05, 1.08],
  [1.2, 0.9, 1.1, 0.95, 1.15, 0.85, 1.0, 1.1],
  [0.9, 1.2, 0.95, 1.1, 0.9, 1.15, 0.95, 1.05],
  [1.1, 0.95, 1.2, 0.9, 1.05, 1.1, 0.9, 1.15],
  [0.95, 1.05, 0.9, 1.2, 0.95, 1.0, 1.1, 0.9],
  [1.15, 0.9, 1.05, 0.95, 1.1, 0.9, 1.2, 1.0],
];

const SHAPES = RADII.map(blobPath);
// 末尾回到第一个形状，循环闭合处不跳变
const VALUES = [...SHAPES, SHAPES[0]].join(';');
const SEG = SHAPES.length;
const KEY_TIMES = Array.from({ length: SEG + 1 }, (_, i) => (i / SEG).toFixed(4)).join(';');
const KEY_SPLINES = Array.from({ length: SEG }, () => '0.45 0 0.55 1').join(';');

const SIZES = ['sm', 'md', 'lg'];

export default defineComponent({
  name: 'Bloub',
  group: 'Media',
  description:
    '会呼吸变形的黑色 blob 头像（纯 SVG 动画，无动画库）：适合当机器人/助手头像、加载动效或界面点缀。参数依次是尺寸、配色、单次变形周期（秒）',
  params: [
    enumOf('size', SIZES, { default: 'md' }),
    enumOf('tone', ['ink', 'outline'], { default: 'ink' }),
    num('speed', { default: 6 }),
  ],
  render: {
    create(p = {}) {
      const size = SIZES.includes(p.size) ? p.size : 'md';
      const outline = p.tone === 'outline';
      const dur = Math.max(1, Number(p.speed) || 6);

      const svg = svgEl('svg');
      svg.setAttribute('viewBox', '0 0 200 200');
      svg.setAttribute('class', `bloub bloub--${size}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', '动画头像');

      const path = svgEl('path');
      path.setAttribute('class', 'bloub__shape');
      path.setAttribute('d', SHAPES[0]);
      if (outline) {
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'var(--bloub-ink, #0a0a0c)');
        path.setAttribute('stroke-width', '6');
        path.setAttribute('stroke-linejoin', 'round');
      } else {
        path.setAttribute('fill', 'var(--bloub-ink, #0a0a0c)');
      }

      const anim = svgEl('animate');
      anim.setAttribute('attributeName', 'd');
      anim.setAttribute('values', VALUES);
      anim.setAttribute('dur', `${dur}s`);
      anim.setAttribute('repeatCount', 'indefinite');
      anim.setAttribute('calcMode', 'spline');
      anim.setAttribute('keyTimes', KEY_TIMES);
      anim.setAttribute('keySplines', KEY_SPLINES);
      path.appendChild(anim);

      svg.appendChild(path);
      return svg;
    },
  },
  css: `
.bloub { display: block; overflow: visible; }
.bloub--sm { width: 48px; height: 48px; }
.bloub--md { width: 88px; height: 88px; }
.bloub--lg { width: 152px; height: 152px; }
@media (prefers-reduced-motion: reduce) { .bloub__shape { animation: none; } }
`,
  markdown: () => '（一个会变形的头像图形）',
});
