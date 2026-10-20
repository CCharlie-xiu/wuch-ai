import { defineComponent, str, num, enumOf } from '../define.js';
import { el, svgEl, fmtNum } from '../dom.js';
import { PALETTE, INK, RAMP, rampAt } from '../palette.js';

// ── 几何 ─────────────────────────────────────────────────────────────────────
// 220° 的弧，开口朝下：从左下 200° 顺时针扫过顶部到右下 -20°。
// SVG 的 y 轴朝下，polar() 里已经把 y 翻回来了，所以角度增大 = 屏幕上逆时针。
const BOX = { w: 200, h: 134 };
const CX = 100;
const CY = 106;
const R = 80;
const W = 13;
const A0 = 200;
const A1 = -20;

const rad = (deg) => (deg * Math.PI) / 180;
const polar = (deg, r) => [CX + r * Math.cos(rad(deg)), CY - r * Math.sin(rad(deg))];
const angleOf = (ratio) => A0 + (A1 - A0) * Math.max(0, Math.min(1, ratio));

/** 弧线路径：角度从 a0 扫到 a1，a0 > a1 时是顺时针过顶，sweep-flag 取 1 */
function arcPath(r, a0, a1) {
  const [x0, y0] = polar(a0, r);
  const [x1, y1] = polar(a1, r);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// 同一页上可能有好几个仪表盘，渐变的 id 不能撞
let uid = 0;

function paint(n, p) {
  const max = Number(p.max) > 0 ? Number(p.max) : 100;
  const value = Math.max(0, Math.min(max, Number(p.value) || 0));
  const ratio = value / max;
  const colors = p.variant === 'brand' ? [PALETTE[0], PALETTE[1]] : RAMP;

  const plot = n.querySelector('.gauge-plot');
  plot.textContent = '';

  const svg = svgEl('svg');
  svg.setAttribute('class', 'gauge-svg');
  svg.setAttribute('viewBox', `0 0 ${BOX.w} ${BOX.h}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${fmtNum(value)} / ${fmtNum(max)}`);

  // 色带：左 → 右铺开，弧上看起来就是从「好」走到「差」
  const gid = `gauge-ramp-${++uid}`;
  const grad = svgEl('linearGradient');
  grad.setAttribute('id', gid);
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '1'); grad.setAttribute('y2', '0');
  colors.forEach((c, i) => {
    const stop = svgEl('stop');
    stop.setAttribute('offset', `${(i / (colors.length - 1)) * 100}%`);
    stop.setAttribute('stop-color', c);
    grad.appendChild(stop);
  });
  const defs = svgEl('defs');
  defs.appendChild(grad);
  svg.appendChild(defs);

  const track = svgEl('path');
  track.setAttribute('d', arcPath(R, A0, A1));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', `url(#${gid})`);
  track.setAttribute('stroke-width', W);
  track.setAttribute('stroke-linecap', 'round');
  svg.appendChild(track);

  // 当前值：白圈套本色圆点，压在弧上
  const [mx, my] = polar(angleOf(ratio), R);
  const halo = svgEl('circle');
  halo.setAttribute('cx', mx.toFixed(2));
  halo.setAttribute('cy', my.toFixed(2));
  halo.setAttribute('r', (W / 2 + 2.5).toFixed(1));
  halo.setAttribute('fill', '#fff');
  halo.setAttribute('class', 'gauge-marker');
  const dot = svgEl('circle');
  dot.setAttribute('cx', mx.toFixed(2));
  dot.setAttribute('cy', my.toFixed(2));
  dot.setAttribute('r', '4.2');
  dot.setAttribute('fill', rampAt(colors, ratio));
  svg.append(halo, dot);

  // 弧口里的读数：大数字 + 浅色分母，一起居中
  const num = svgEl('text');
  num.setAttribute('x', CX);
  num.setAttribute('y', CY + 12);
  num.setAttribute('text-anchor', 'middle');
  const big = svgEl('tspan');
  big.setAttribute('font-size', '32');
  big.setAttribute('font-weight', '700');
  big.setAttribute('fill', INK.text);
  big.textContent = fmtNum(value);
  const den = svgEl('tspan');
  den.setAttribute('font-size', '14');
  den.setAttribute('fill', INK.dim);
  den.setAttribute('dx', '6');
  den.textContent = `/ ${fmtNum(max)}`;
  num.append(big, den);
  svg.appendChild(num);

  plot.appendChild(svg);

  const status = n.querySelector('.gauge-status');
  status.textContent = p.status || '';
  status.style.display = p.status ? '' : 'none';
}

export default defineComponent({
  name: 'Gauge',
  group: 'Charts',
  description: '弧形仪表盘：value / max 的当前档位，弧上有个圆点标位置；status 是下方的一句话（如「正常」）。适合压力、负载、完成度这类「有刻度感」的单一指标',
  skeleton: { h: 190 },
  params: [
    num('value', { required: true }),
    num('max', { default: 100 }),
    str('status'),
    enumOf('variant', ['scale', 'brand'], { default: 'scale' }),
  ],
  render: {
    create(p) {
      const n = el('div', 'gauge');
      n.appendChild(el('div', 'gauge-plot'));
      n.appendChild(el('div', 'gauge-status'));
      paint(n, p);
      return n;
    },
    updates: ['value', 'max', 'status', 'variant'],
    update(n, p) {
      paint(n, p);
    },
  },
  markdown: (p) => `- 仪表盘：**${p.value ?? '—'} / ${p.max ?? 100}**${p.status ? `（${p.status}）` : ''}`,
  css: `
.gauge { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.gauge-plot { width: 100%; max-width: 240px; }
.gauge-svg { display: block; width: 100%; height: auto; font-family: var(--sans); }
.gauge-marker { filter: drop-shadow(0 1px 3px rgba(15, 23, 42, .2)); }
.gauge-status { font-size: 12px; font-weight: 600; color: ${INK.muted}; letter-spacing: .01em; }
`,
});
