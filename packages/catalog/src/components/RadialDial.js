import { defineComponent, str, num } from '../define.js';
import { el, svgEl } from '../dom.js';
import { PALETTE, INK, mix, rgba } from '../palette.js';

// ── 几何 ─────────────────────────────────────────────────────────────────────
// 一圈刻度：从正上方开始顺时针排 60 根，走过的部分上色、没走到的留浅灰。
const BOX = 200;
const CX = 100;
const CY = 100;
const R_IN = 68;
const R_OUT = 86;
const TICKS = 60;
const HALF = 2.6 / 2;

const rad = (deg) => (deg * Math.PI) / 180;
const polar = (deg, r) => [CX + r * Math.cos(rad(deg)), CY - r * Math.sin(rad(deg))];

function paint(n, p) {
  const ratio = Math.max(0, Math.min(100, Number(p.progress ?? 100))) / 100;
  const on = Math.round(ratio * TICKS);

  const plot = n.querySelector('.dial-plot');
  plot.textContent = '';

  const svg = svgEl('svg');
  svg.setAttribute('class', 'dial-svg');
  svg.setAttribute('viewBox', `0 0 ${BOX} ${BOX}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', [p.value, p.caption].filter(Boolean).join(' '));

  // 中心的浅色圆盘，让数字和刻度之间有个底
  const disc = svgEl('circle');
  disc.setAttribute('cx', CX);
  disc.setAttribute('cy', CY);
  disc.setAttribute('r', R_IN - 8);
  disc.setAttribute('fill', rgba(PALETTE[0], 0.05));
  svg.appendChild(disc);

  for (let i = 0; i < TICKS; i++) {
    const deg = -90 - (360 / TICKS) * i;
    const [x1, y1] = polar(deg, R_IN);
    const [x2, y2] = polar(deg, R_OUT);
    const line = svgEl('line');
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2));
    line.setAttribute('y2', y2.toFixed(2));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-width', String(HALF * 2));
    // 走过的刻度按角度从蓝走到紫，没走到的是浅灰
    line.setAttribute('stroke', i < on ? mix(PALETTE[0], PALETTE[1], i / (TICKS - 1)) : INK.line);
    svg.appendChild(line);
  }

  if (p.value) {
    const t = svgEl('text');
    t.setAttribute('x', CX);
    t.setAttribute('y', CY + (p.caption ? 4 : 9));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', '30');
    t.setAttribute('font-weight', '700');
    t.setAttribute('fill', INK.text);
    t.textContent = p.value;
    svg.appendChild(t);
  }

  if (p.caption) {
    const c = svgEl('text');
    c.setAttribute('x', CX);
    c.setAttribute('y', CY + 26);
    c.setAttribute('text-anchor', 'middle');
    c.setAttribute('font-size', '11.5');
    c.setAttribute('fill', INK.dim);
    c.textContent = p.caption;
    svg.appendChild(c);
  }

  plot.appendChild(svg);
}

export default defineComponent({
  name: 'RadialDial',
  group: 'Charts',
  description: '刻度环：中间一行大字（value，如 "7h 24m"），外面一圈刻度，progress（0–100）决定走了多少格；caption 是数字下面的小字',
  skeleton: { h: 190 },
  params: [
    str('value', { required: true }),
    num('progress', { default: 100 }),
    str('caption'),
  ],
  render: {
    create(p) {
      const n = el('div', 'dial');
      n.appendChild(el('div', 'dial-plot'));
      paint(n, p);
      return n;
    },
    updates: ['value', 'progress', 'caption'],
    update(n, p) {
      paint(n, p);
    },
  },
  markdown: (p) => `- ${p.caption ? `${p.caption}：` : ''}**${p.value ?? '—'}**`,
  css: `
.dial { display: flex; flex-direction: column; align-items: center; }
.dial-plot { width: 100%; max-width: 220px; }
.dial-svg { display: block; width: 100%; height: auto; font-family: var(--sans); }
`,
});
