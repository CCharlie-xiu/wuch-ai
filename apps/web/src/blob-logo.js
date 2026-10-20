// ─────────────────────────────────────────────────────────────────────────────
// 品牌 logo：会眨眼、换表情的云朵（造型与表情参数取自 bloub.vercel.app）。
// 身体 = 64 个极坐标半径连成的平滑闭合曲线；眼睛 = 胶囊形，按「视线」做 3D 旋转后
// 投影到脸上，再用 mask 挖空，所以放在任何底色上都是镂空的眼睛。
// 挂载点：<svg data-blob-logo>，由 shell 统一调用 mountBlobLogos()。
// ─────────────────────────────────────────────────────────────────────────────

const N = 64;
const TAU = Math.PI * 2;
const R = 100;
const COLOR = '#3b93f0';
const HOLD = 2.2;
const MORPH = 0.45;

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const q = (v) => Math.round(v * 100) / 100;
const easeOutQuint = (t) => 1 - (1 - t) ** 5;
const rad = (d) => (d * Math.PI) / 180;

const ANG = Array.from({ length: N }, (_, i) => (i / N) * TAU);
const COS = ANG.map(Math.cos);
const SIN = ANG.map(Math.sin);

function circlesUnion(circles) {
  return ANG.map((_, i) => {
    let best = 0;
    for (const c of circles) {
      const p = COS[i] * c.x + SIN[i] * c.y;
      const disc = p * p - (c.x * c.x + c.y * c.y - c.r * c.r);
      if (disc < 0) continue;
      best = Math.max(best, p + Math.sqrt(disc));
    }
    return best;
  });
}
function normalize(radii, to = 1) {
  const max = Math.max(...radii);
  return radii.map((r) => (r * to) / max);
}

const CLOUD = normalize(circlesUnion([
  { x: -0.44, y: 0.2, r: 0.54 },
  { x: 0.46, y: 0.2, r: 0.5 },
  { x: 0.02, y: 0.3, r: 0.6 },
  { x: -0.24, y: -0.3, r: 0.48 },
  { x: 0.3, y: -0.24, r: 0.44 },
]), 1.02);

function radiusAt(angle) {
  const f = (((angle / TAU) % 1) + 1) % 1 * N;
  const i = Math.floor(f);
  return lerp(CLOUD[i % N], CLOUD[(i + 1) % N], f - i);
}

const eye = (w, h, tilt = 0, open = 1) => ({ w, h, tilt, open });
const pair = (w, h, tilt = 0, open = 1) => [eye(w, h, tilt, open), eye(w, h, -tilt, open)];

const EXPRESSIONS = [
  { id: 'neutre', gaze: { yaw: 28.49, pitch: 28.62, roll: -13 }, split: 15.46, eyes: pair(0.186, 0.412) },
  { id: 'attentif', gaze: { yaw: 4, pitch: 5, roll: -4 }, split: 16, eyes: pair(0.21, 0.44) },
  { id: 'surpris', gaze: { yaw: 3, pitch: -3, roll: 0 }, split: 19, eyes: pair(0.45, 0.47) },
  { id: 'excite', gaze: { yaw: 6, pitch: -14, roll: 0 }, split: 19.5, eyes: pair(0.4, 0.56, -10) },
  { id: 'heureux', gaze: { yaw: 5, pitch: 9, roll: 0 }, split: 17, eyes: pair(0.27, 0.17, 14) },
  { id: 'hilare', gaze: { yaw: 4, pitch: 14, roll: 0 }, split: 18, eyes: pair(0.34, 0.13, 20) },
  { id: 'colere', gaze: { yaw: 3, pitch: 7, roll: 0 }, split: 17, eyes: pair(0.34, 0.15, 30) },
  { id: 'triste', gaze: { yaw: 3, pitch: -13, roll: 0 }, split: 16, eyes: pair(0.22, 0.4, -28) },
  { id: 'effraye', gaze: { yaw: 2, pitch: -20, roll: 0 }, split: 20.5, eyes: pair(0.4, 0.6) },
  { id: 'mefiant', gaze: { yaw: 12, pitch: 6, roll: -6 }, split: 16, eyes: [eye(0.21, 0.4), eye(0.22, 0.15)] },
  { id: 'confus', gaze: { yaw: -14, pitch: 3, roll: 8 }, split: 16.5, eyes: [eye(0.2, 0.44, -18), eye(0.28, 0.17, 14)] },
  { id: 'curieux', gaze: { yaw: 16, pitch: -9, roll: -15 }, split: 16.5, eyes: [eye(0.24, 0.46, -8), eye(0.2, 0.38, -8)] },
  { id: 'fier', gaze: { yaw: 5, pitch: 17, roll: 0 }, split: 17, eyes: pair(0.3, 0.15, 18) },
  { id: 'timide', gaze: { yaw: -19, pitch: -14, roll: -7 }, split: 14, eyes: pair(0.17, 0.3) },
  { id: 'blase', gaze: { yaw: -22, pitch: 2, roll: 0 }, split: 16, eyes: pair(0.3, 0.12) },
  { id: 'somnolent', gaze: { yaw: 6, pitch: -9, roll: -3 }, split: 16, eyes: pair(0.2, 0.42, 0, 0.42) },
];

const mixEye = (a, b, t) => ({ w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t), tilt: lerp(a.tilt, b.tilt, t), open: lerp(a.open, b.open, t) });
function mixExpr(a, b, t) {
  return {
    gaze: { yaw: lerp(a.gaze.yaw, b.gaze.yaw, t), pitch: lerp(a.gaze.pitch, b.gaze.pitch, t), roll: lerp(a.gaze.roll, b.gaze.roll, t) },
    split: lerp(a.split, b.split, t),
    eyes: [mixEye(a.eyes[0], b.eyes[0], t), mixEye(a.eyes[1], b.eyes[1], t)],
  };
}

// 低频噪声：几个正弦叠加，让视线 / 漂移看起来不机械
function wobble(t, period, phase = 0) {
  const a = (t / period) * TAU;
  return 0.55 * Math.sin(a + phase) + 0.3 * Math.sin(2 * a + phase * 1.7 + 1.1) + 0.15 * Math.sin(3 * a + phase * 2.3 + 2.4);
}

function rotate(u, v, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
  ];
}

// 视线 → 两只眼在脸上的位置与局部坐标系（含透视压缩）
function project(gaze, split) {
  let fwd = [0, 0, 1], right = [1, 0, 0], up = [0, 1, 0];
  [fwd, right] = rotate(fwd, right, rad(gaze.yaw));
  [up, fwd] = rotate(up, fwd, rad(gaze.pitch));
  [right, up] = rotate(right, up, rad(gaze.roll));
  return [-1, 1].map((side) => {
    const [p, r] = rotate(fwd, right, rad(split * side));
    return { x: p[0] * R, y: p[1] * R, a: r[0], b: r[1], c: up[0], d: up[1], depth: p[2] };
  });
}

function pill(w, h) {
  const hw = Math.max(w, 0.01) / 2, hh = Math.max(h, 0.01) / 2, r = Math.min(hw, hh);
  return `M${q(-hw)} ${q(-hh + r)}A${q(r)} ${q(r)} 0 0 1 ${q(-hw + r)} ${q(-hh)}L${q(hw - r)} ${q(-hh)}A${q(r)} ${q(r)} 0 0 1 ${q(hw)} ${q(-hh + r)}L${q(hw)} ${q(hh - r)}A${q(r)} ${q(r)} 0 0 1 ${q(hw - r)} ${q(hh)}L${q(-hw + r)} ${q(hh)}A${q(r)} ${q(r)} 0 0 1 ${q(-hw)} ${q(hh - r)}Z`;
}

function bodyPath(ox, oy, sy) {
  const pts = CLOUD.map((r, i) => ({ x: (r * COS[i] + ox) * R, y: (r * SIN[i] * sy + oy) * R }));
  const k = 1 / 6;
  let d = `M${q(pts[0].x)} ${q(pts[0].y)}`;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    d += `C${q(p1.x + (p2.x - p0.x) * k)} ${q(p1.y + (p2.y - p0.y) * k)} ${q(p2.x - (p3.x - p1.x) * k)} ${q(p2.y - (p3.y - p1.y) * k)} ${q(p2.x)} ${q(p2.y)}`;
  }
  return d + 'Z';
}

function frame(expr, t, lid, still) {
  const gaze = still ? expr.gaze : {
    yaw: expr.gaze.yaw + wobble(t, 11.3, 0.4) * 5.5 + wobble(t, 3.7, 2.1) * 1.6,
    pitch: expr.gaze.pitch + wobble(t, 9.1, 1.3) * 4.2 + wobble(t, 4.3, 0.7) * 1.3,
    roll: expr.gaze.roll + wobble(t, 13.7, 3.2) * 2.2,
  };
  const ox = still ? 0 : wobble(t, 7.9, 1.9) * 0.006;
  const oy = still ? 0 : wobble(t, 5.3, 0.3) * 0.007;
  const breath = still ? 1 : 1 + Math.sin((t / 3.4) * TAU) * 0.005;

  const eyes = [];
  project(gaze, expr.split).forEach((o, n) => {
    if (o.depth <= 0.02) return;
    const e = expr.eyes[n];
    const s = radiusAt(Math.atan2(o.y, o.x));
    const c = Math.cos(rad(e.tilt)), si = Math.sin(rad(e.tilt));
    const v = 0.06 + 0.94 * clamp(Math.min(lid, e.open));
    const m = [o.a * c + o.c * si, (o.b * c + o.d * si) * v, -o.a * si + o.c * c, (-o.b * si + o.d * c) * v];
    eyes.push({
      d: pill(e.w * R, e.h * R),
      transform: `matrix(${m.map(q).join(',')},${q(o.x * s + ox * R)},${q(o.y * s + oy * R)})`,
      opacity: clamp(o.depth / 0.12),
    });
  });
  return { body: bodyPath(ox, oy, breath), eyes };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

let uid = 0;
function mount(svg, still) {
  const id = `blob-logo-mask-${++uid}`;
  svg.setAttribute('viewBox', '-112 -112 224 224');
  svg.replaceChildren();
  const mask = el('mask', { id, maskUnits: 'userSpaceOnUse', x: -130, y: -130, width: 260, height: 260 });
  const maskBody = el('path', { fill: '#fff' });
  const eyePaths = [el('path', { fill: '#000' }), el('path', { fill: '#000' })];
  mask.append(maskBody, ...eyePaths);
  const defs = el('defs');
  defs.append(mask);
  const body = el('path', { fill: COLOR, mask: `url(#${id})` });
  svg.append(defs, body);

  return (expr, t, lid) => {
    const f = frame(expr, t, lid, still);
    maskBody.setAttribute('d', f.body);
    body.setAttribute('d', f.body);
    eyePaths.forEach((p, i) => {
      const e = f.eyes[i];
      if (!e) return p.setAttribute('d', '');
      p.setAttribute('d', e.d);
      p.setAttribute('transform', e.transform);
      p.setAttribute('fill-opacity', String(q(e.opacity)));
    });
  };
}

export function mountBlobLogos(root = document) {
  const svgs = [...root.querySelectorAll('svg[data-blob-logo]')];
  if (!svgs.length) return;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const draws = svgs.map((s) => mount(s, still));
  if (still) {
    draws.forEach((draw) => draw(EXPRESSIONS[0], 0, 1));
    return;
  }

  const t0 = performance.now();
  let idx = 0, prev = EXPRESSIONS[0], changedAt = 0;
  let blinkAt = 1.4 + Math.random() * 2;

  const tick = (now) => {
    const t = (now - t0) / 1000;
    if (t - changedAt >= HOLD) {
      prev = EXPRESSIONS[idx];
      idx = (idx + 1) % EXPRESSIONS.length;
      changedAt = t;
    }
    const k = clamp((t - changedAt) / MORPH);
    const expr = k >= 1 ? EXPRESSIONS[idx] : mixExpr(prev, EXPRESSIONS[idx], easeOutQuint(k));

    let lid = 1;
    const b = (t - blinkAt) / 0.18;
    if (b >= 0 && b <= 1) lid = b < 0.45 ? 1 - b / 0.45 : (b - 0.45) / 0.55;
    else if (b > 1) blinkAt = t + 1.9 + Math.random() * 2.7;

    draws.forEach((draw) => draw(expr, t, lid));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
