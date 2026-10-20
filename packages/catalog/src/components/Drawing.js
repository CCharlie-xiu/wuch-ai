import { defineComponent, list, num, str } from '../define.js';
import { el, icon } from '../dom.js';

/** 语义色：canvas 画不了 CSS 变量，导出 PNG 也要和页面一致，所以取固定值 */
export const PALETTE = {
  primary: '#2563eb',
  success: '#15803d',
  warning: '#b45309',
  danger: '#b91c1c',
  info: '#1d4ed8',
  muted: '#6b7280',
  text: '#1f2328',
  surface: '#f6f7f9',
  white: '#ffffff',
};

/** 模型写的颜色 → 能交给 canvas 的颜色；不认识的返回 fallback（不放行任意 CSS 字符串） */
export function color(v, fallback) {
  if (v == null || v === '') return fallback;
  const s = String(v).trim();
  if (Object.hasOwn(PALETTE, s)) return PALETTE[s];
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  return fallback;
}

const n = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const FONT = '"LXGW WenKai Screen", "PingFang SC", system-ui, sans-serif';

function text(g, str, x, y, { size = 14, fill = PALETTE.text, align = 'center', weight = 'regular' } = {}) {
  if (str == null || str === '') return;
  g.fillStyle = fill;
  g.font = `${weight === 'bold' ? 650 : 400} ${size}px ${FONT}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  const lines = String(str).split('\n');
  const lh = size * 1.3;
  lines.forEach((line, i) => g.fillText(line, x, y + (i - (lines.length - 1) / 2) * lh));
}

function points(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  if (arr.every((p) => Array.isArray(p))) return arr.map((p) => [n(p[0]), n(p[1])]);
  const out = [];
  for (let i = 0; i + 1 < arr.length; i += 2) out.push([n(arr[i]), n(arr[i + 1])]);
  return out;
}

/** 按 __type 画一个图元；坐标已经是逻辑坐标（外面统一缩放） */
export function drawShape(g, s) {
  if (!s || typeof s !== 'object') return;
  g.save();
  g.setLineDash(s.dashed ? [6, 5] : []);
  switch (s.__type) {
    case 'Rect': {
      const x = n(s.x);
      const y = n(s.y);
      const w = n(s.w);
      const h = n(s.h);
      g.beginPath();
      const r = Math.max(0, Math.min(n(s.radius), w / 2, h / 2));
      if (g.roundRect) g.roundRect(x, y, w, h, r);
      else g.rect(x, y, w, h);
      const fill = color(s.fill, s.stroke ? null : PALETTE.surface);
      if (fill) {
        g.fillStyle = fill;
        g.fill();
      }
      const stroke = color(s.stroke, null);
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = 1.5;
        g.stroke();
      }
      text(g, s.label, x + w / 2, y + h / 2, { fill: color(s.labelColor, PALETTE.text) });
      break;
    }
    case 'Circle': {
      g.beginPath();
      g.arc(n(s.cx), n(s.cy), Math.max(0, n(s.r)), 0, Math.PI * 2);
      const fill = color(s.fill, s.stroke ? null : PALETTE.surface);
      if (fill) {
        g.fillStyle = fill;
        g.fill();
      }
      const stroke = color(s.stroke, null);
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = 1.5;
        g.stroke();
      }
      text(g, s.label, n(s.cx), n(s.cy), { fill: color(s.labelColor, PALETTE.text) });
      break;
    }
    case 'Line':
    case 'Arrow': {
      const x1 = n(s.x1);
      const y1 = n(s.y1);
      const x2 = n(s.x2);
      const y2 = n(s.y2);
      const stroke = color(s.stroke, PALETTE.text);
      const w = Math.max(0.5, n(s.width, 2));
      g.strokeStyle = stroke;
      g.lineWidth = w;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      if (s.__type === 'Arrow') {
        const a = Math.atan2(y2 - y1, x2 - x1);
        const len = 8 + w * 2;
        g.setLineDash([]);
        g.fillStyle = stroke;
        g.beginPath();
        g.moveTo(x2, y2);
        g.lineTo(x2 - len * Math.cos(a - 0.42), y2 - len * Math.sin(a - 0.42));
        g.lineTo(x2 - len * Math.cos(a + 0.42), y2 - len * Math.sin(a + 0.42));
        g.closePath();
        g.fill();
        text(g, s.label, (x1 + x2) / 2, (y1 + y2) / 2 - 12, { size: 12, fill: PALETTE.muted });
      }
      break;
    }
    case 'Path': {
      const pts = points(s.points);
      if (pts.length < 2) break;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
      if (s.closed) g.closePath();
      const fill = s.closed ? color(s.fill, null) : null;
      if (fill) {
        g.fillStyle = fill;
        g.fill();
      }
      g.strokeStyle = color(s.stroke, PALETTE.text);
      g.lineWidth = Math.max(0.5, n(s.width, 2));
      g.lineJoin = 'round';
      g.stroke();
      break;
    }
    case 'Label':
      text(g, s.text, n(s.x), n(s.y), { size: Math.max(8, n(s.size, 14)), fill: color(s.color, PALETTE.text), align: s.align || 'left', weight: s.weight });
      break;
    default:
      break;
  }
  g.restore();
}

function paint(canvas, p) {
  const box = canvas.parentNode;
  const cssW = (box && box.clientWidth) || n(p.width, 800);
  const lw = Math.max(1, n(p.width, 800));
  const lh = Math.max(1, n(p.height, 450));
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const scale = (cssW / lw) * dpr;
  canvas.width = Math.round(lw * scale);
  canvas.height = Math.round(lh * scale);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.clearRect(0, 0, lw, lh);
  g.fillStyle = color(p.background, PALETTE.white);
  g.fillRect(0, 0, lw, lh);
  for (const s of p.shapes || []) drawShape(g, s);
}

export default defineComponent({
  name: 'Drawing',
  group: 'Canvas',
  skill: 'canvas',
  description: '画布：在 width × height 的逻辑坐标里画 shapes（Rect / Circle / Line / Arrow / Path / Label），按容器宽度等比缩放，可导出 PNG',
  skeleton: { ratio: '16 / 9' },
  params: [
    list('shapes', { required: true }),
    num('width', { default: 800 }),
    num('height', { default: 450 }),
    str('background'),
    str('caption'),
  ],
  render: {
    create(p) {
      const fig = el('figure', 'figure drawing');
      const box = el('div', 'drawing-box');
      box.style.aspectRatio = `${Math.max(1, n(p.width, 800))} / ${Math.max(1, n(p.height, 450))}`;
      const canvas = el('canvas', 'drawing-canvas');
      box.appendChild(canvas);
      const save = el('button', 'drawing-save');
      save.type = 'button';
      save.title = '导出 PNG';
      save.appendChild(icon('download', 'icon xs'));
      save.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = `${p.caption || p.__var || 'drawing'}.png`;
        a.click();
      });
      box.appendChild(save);
      fig.appendChild(box);
      if (p.caption) fig.appendChild(el('figcaption', null, p.caption));
      fig.__props = p;
      let paintRaf = 0;
      const redraw = () => {
        paintRaf = 0;
        paint(canvas, fig.__props);
      };
      const schedule = () => {
        if (!paintRaf) paintRaf = requestAnimationFrame(redraw);
      };
      fig.__schedulePaint = schedule;
      // 还没进文档时量不到宽度：进文档后、以及容器尺寸变化时重画
      schedule();
      if (typeof ResizeObserver !== 'undefined') {
        let last = 0;
        new ResizeObserver(() => {
          if (box.clientWidth && box.clientWidth !== last) {
            last = box.clientWidth;
            schedule();
          }
        }).observe(box);
      }
      return fig;
    },
    updates: ['shapes', 'width', 'height', 'background'],
    update(fig, p) {
      fig.__props = p;
      const box = fig.querySelector('.drawing-box');
      if (box) box.style.aspectRatio = `${Math.max(1, n(p.width, 800))} / ${Math.max(1, n(p.height, 450))}`;
      // 流式时 shapes 每 240ms 变长一次：合并到下一帧再画，避免主线程被 canvas 重绘占满
      if (typeof fig.__schedulePaint === 'function') fig.__schedulePaint();
      else {
        const canvas = fig.querySelector('canvas');
        if (canvas) paint(canvas, p);
      }
    },
  },
  markdown(p) {
    const parts = (p.shapes || []).map((s) => s.label || s.text).filter(Boolean);
    return `（示意图${p.caption ? `：${p.caption}` : ''}${parts.length ? ` —— ${parts.join('、')}` : ''}）`;
  },
  css: `
.drawing-box { position: relative; width: 100%; border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); border-radius: 11px; overflow: hidden; background: #ffffff; }
.drawing-canvas { display: block; width: 100%; height: 100%; }
.drawing-save { position: absolute; top: 8px; right: 8px; display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); background: rgba(255,255,255,.92); color: var(--ui-ink-3); cursor: pointer; opacity: 0; transition: opacity .15s; }
.drawing-box:hover .drawing-save { opacity: 1; }
`,
});
