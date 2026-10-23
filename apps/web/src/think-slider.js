// ─────────────────────────────────────────────────────────────────────────────
// 思考强度胶囊：一条胶囊轨道 + 四枚递高的刻度 + 一枚白色拇指。
//
// 拖动的时候，胶囊顶部会「长出一个肩部」，把当前档位托到轨道外面；松手肩部收回、
// 数值吸附到最近一档。静止时它只是一条胶囊，不占额外的文字行。
//
// 形态参考 aicss 的 reasoning-effort（Kevin），几何算法一并移植：
// 肩部不是圆角矩形拼出来的，而是一段贝塞尔；平台一旦靠近端盖圆顶，肩脚就要顺着
// 圆的切线往下塌（phi），否则会戳出胶囊轮廓。移植时把 React 的 setState 换成
// 手写 rAF，四条动画各自独立（开合 220ms / 平台宽 90ms / 标签显隐 132·90ms）。
//
// 坐标系固定 224×52（1 单位 = 1px），SVG 不做缩放 —— 这样
// getBoundingClientRect 量到的像素可以直接当坐标用，拇指和外壳才咬得住。
// ─────────────────────────────────────────────────────────────────────────────

const TRACK = 224;
const HEIGHT = 32;
const RADIUS = HEIGHT / 2;
const BUMP_H = 20;
const REST_W = 27.2;
const DRAG_W = 33.6;
const REST_H = 27.2;
const EDGE_PAD = (HEIGHT - REST_H) / 2;

/** 肩脚到平台的水平距离（参考值），肩部曲线的左右宽度都以它为基准缩放 */
const LEFT_SHOULDER = 23.572;
/** 文字两侧留白：从字边到肩脚 */
const TEXT_SIDE = 20;
/** 平台越过圆顶后，肩脚沿切线往下走的最大角度（0~0.6 弧度） */
const PHI_MAX = 0.6;
const PHI_REACH = 36;

/** 刻度高度：越靠右越高，暗示思考预算递增 */
const TICK_MIN = 4.8;
const TICK_MAX = 9.6;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const easeOut = (t) => 1 - (1 - t) ** 3;
const smoothstep = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** 平台宽度：文字宽 + 两侧留白，再扣掉两条肩部占掉的宽度 */
function plateauFor(textW) {
  return Math.max(8, textW + TEXT_SIDE * 2 - LEFT_SHOULDER * 2);
}

/** 圆顶上的落点：phi 是肩脚贴着圆走的角度 */
function capFoot(side, phi) {
  const crown = side === -1 ? RADIUS : TRACK - RADIUS;
  return {
    x: crown + side * RADIUS * Math.sin(phi),
    y: BUMP_H + RADIUS * (1 - Math.cos(phi)),
  };
}

/**
 * 平台两端的位置。平台一旦探进端盖圆顶的范围，就按溢出的距离把肩脚顺着圆塌下去，
 * 并把平台往内推同样多的量，保证文字仍然居中。
 */
function shellGeom(cx, plateauW) {
  const crownL = RADIUS;
  const crownR = TRACK - RADIUS;
  let topL = cx - plateauW / 2;
  let topR = topL + plateauW;
  let phiL = 0;
  let phiR = 0;

  const overflowL = crownL - (topL - LEFT_SHOULDER);
  if (overflowL > 0) {
    phiL = PHI_MAX * smoothstep(overflowL / PHI_REACH);
    const foot = capFoot(-1, phiL);
    const minTopL = foot.x + LEFT_SHOULDER * Math.cos(phiL);
    if (topL < minTopL) {
      topR += minTopL - topL;
      topL = minTopL;
    }
  }

  const overflowR = topR + LEFT_SHOULDER - crownR;
  if (overflowR > 0) {
    phiR = PHI_MAX * smoothstep(overflowR / PHI_REACH);
    const foot = capFoot(1, phiR);
    const maxTopR = foot.x - LEFT_SHOULDER * Math.cos(phiR);
    if (topR > maxTopR) {
      topL -= topR - maxTopR;
      topR = maxTopR;
    }
  }

  // 斜过去的肩部在 x 方向上变短，会把文字往外面拽一点；把平台向内补回来
  const insetL = phiL > 0 ? LEFT_SHOULDER * (1 - Math.cos(phiL)) : 0;
  const insetR = phiR > 0 ? LEFT_SHOULDER * (1 - Math.cos(phiR)) : 0;
  topR += insetL;
  topL -= insetR;

  return { topL, topR, phiL, phiR, insetL, insetR };
}

/** 一条肩部：从胶囊顶边（或圆顶落点）弯上平台 */
function shoulderCmds(footX, footY, platX, platY, phi, dir) {
  const xScale = Math.abs(platX - footX) / LEFT_SHOULDER;
  const yScale = Math.max(0.001, (footY - platY) / 20);
  const tangent = { x: dir * Math.cos(phi), y: -Math.sin(phi) };
  const map = (lx, ly) => ({
    x: footX + dir * lx * xScale,
    y: footY + (ly - 20) * yScale,
  });
  const h1 = 5.398 * xScale;
  const p0 = { x: footX, y: footY };
  const c1 = { x: footX + tangent.x * h1, y: footY + tangent.y * h1 };
  const c2 = map(10.012, 16.114);
  const p1 = map(10.93, 10.794);
  const c3 = map(11.916, 4.577);
  const c4 = map(17.277, 0);
  const p3 = { x: platX, y: platY };
  const fmt = (p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  if (dir === 1) return `C${fmt(c1)} ${fmt(c2)} ${fmt(p1)}C${fmt(c3)} ${fmt(c4)} ${fmt(p3)}`;
  return `C${fmt(c4)} ${fmt(c3)} ${fmt(p1)}C${fmt(c2)} ${fmt(c1)} ${fmt(p0)}`;
}

/** 一整条轮廓：胶囊本体，加上从顶边长出来的标签肩部 */
function shellPath(cx, open, plateauW) {
  const trackTop = BUMP_H;
  const trackBot = BUMP_H + HEIGHT;
  const crownL = RADIUS;
  const crownR = TRACK - RADIUS;
  // 肩部完全收起时就是一条纯胶囊，别让弧线在小数点后面抖
  if (open < 0.012) {
    return `M${crownL} ${trackTop}H${crownR}A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}H${crownL}A${RADIUS} ${RADIUS} 0 0 1 ${crownL} ${trackTop}Z`;
  }

  const bumpTop = BUMP_H * (1 - open);
  const { topL, topR, phiL, phiR } = shellGeom(cx, plateauW);
  const cmds = [`M${crownL} ${trackBot}`];

  if (phiL > 0.001) {
    const foot = capFoot(-1, phiL);
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${foot.x.toFixed(2)} ${foot.y.toFixed(2)}`);
    cmds.push(shoulderCmds(foot.x, foot.y, topL, bumpTop, phiL, 1));
  } else {
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownL} ${trackTop}`);
    const footL = topL - LEFT_SHOULDER;
    if (footL > crownL + 0.4) cmds.push(`H${footL.toFixed(2)}`);
    cmds.push(shoulderCmds(footL, trackTop, topL, bumpTop, 0, 1));
  }

  if (topR > topL + 0.4) cmds.push(`H${topR.toFixed(2)}`);

  if (phiR > 0.001) {
    const foot = capFoot(1, phiR);
    cmds.push(shoulderCmds(foot.x, foot.y, topR, bumpTop, phiR, -1));
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}`);
  } else {
    const footR = topR + LEFT_SHOULDER;
    cmds.push(shoulderCmds(footR, trackTop, topR, bumpTop, 0, -1));
    if (footR < crownR - 0.4) cmds.push(`H${crownR}`);
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}`);
  }

  cmds.push(`H${crownL}Z`);
  return cmds.join('');
}

let uid = 0;

/**
 * @param {object} o
 * @param {HTMLElement} o.root   容器（尺寸固定 224×52，类名 re-pill）
 * @param {string[]} o.stops     档位名，从左到右
 * @param {string} [o.lead]      标签前半段（默认「思考」）
 * @param {number} [o.value]     初始档位
 * @param {(i:number)=>void} [o.onLevel] 档位改变（拖动跨中线 / 键盘 / 点轨道）
 */
export function createThinkSlider({ root, stops, lead = '思考', value = 0, onLevel }) {
  const last = Math.max(1, stops.length - 1);
  const centerFor = (v) => RADIUS + (v / last) * (TRACK - RADIUS * 2);
  const tickHeight = (i) => (stops.length > 1 ? TICK_MIN + ((TICK_MAX - TICK_MIN) * i) / last : TICK_MIN);

  const gid = `re-grad-${++uid}`;
  root.classList.add('re-pill');
  root.innerHTML = `
    <svg class="re-shell" viewBox="0 0 ${TRACK} ${BUMP_H + HEIGHT}" aria-hidden="true">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="re-shell-top" />
          <stop offset="1" class="re-shell-bot" />
        </linearGradient>
      </defs>
      <path class="re-outline" fill="url(#${gid})" stroke-width="0.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="re-label" aria-hidden="true">
      <span class="re-label__lead">${lead}</span><span class="re-label__level"></span>
    </div>
    <div class="re-track" role="slider" tabindex="0" aria-label="思考强度"
         aria-valuemin="0" aria-valuemax="${last}" aria-valuenow="${clamp(Math.round(value), 0, last)}">
      <div class="re-fill"></div>
      <div class="re-thumb"></div>
    </div>`;

  const path = root.querySelector('.re-outline');
  const label = root.querySelector('.re-label');
  const levelEl = root.querySelector('.re-label__level');
  const track = root.querySelector('.re-track');
  const fill = root.querySelector('.re-fill');
  const thumb = root.querySelector('.re-thumb');
  const ticks = stops.map((_, i) => {
    const el = document.createElement('span');
    el.className = 're-tick';
    el.style.height = `${tickHeight(i)}px`;
    track.appendChild(el);
    return el;
  });

  const reduceQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reduce = !!reduceQuery?.matches;
  reduceQuery?.addEventListener?.('change', (e) => { reduce = e.matches; });

  const state = {
    value: clamp(value, 0, last), // 已落定的档位
    display: clamp(value, 0, last), // 动画中的连续位置
    open: 0, // 肩部开合 0~1
    plateau: plateauFor(64),
    reveal: 0, // 标签显隐 0~1
    focused: false,
  };
  let dragging = false;
  let releasedAt = 0;
  let notified = Math.round(state.value);
  const anims = { open: 0, value: 0, plateau: 0, reveal: 0 };

  function cancel(key) {
    if (anims[key]) cancelAnimationFrame(anims[key]);
    anims[key] = 0;
  }

  function tween(key, { from, to, dur, delay = 0, step }) {
    cancel(key);
    if (reduce || Math.abs(to - from) < 1e-4) {
      step(1, 1);
      return;
    }
    const t0 = performance.now();
    const run = (now) => {
      const elapsed = now - t0 - delay;
      if (elapsed < 0) {
        anims[key] = requestAnimationFrame(run);
        return;
      }
      const t = Math.min(1, elapsed / dur);
      step(easeOut(t), t);
      anims[key] = t < 1 ? requestAnimationFrame(run) : 0;
    };
    anims[key] = requestAnimationFrame(run);
  }

  function render() {
    const center = centerFor(state.display);
    const thumbW = REST_W + (DRAG_W - REST_W) * state.open;
    let left = center - thumbW / 2;
    let right = left + thumbW;
    if (left < EDGE_PAD) {
      left = EDGE_PAD;
      right = left + thumbW;
    }
    if (right > TRACK - EDGE_PAD) {
      right = TRACK - EDGE_PAD;
      left = right - thumbW;
    }
    const fillW = Math.min(TRACK, right + EDGE_PAD);

    path.setAttribute('d', shellPath(center, state.open, state.plateau));

    const geom = shellGeom(center, state.plateau);
    label.style.left = `${(geom.topL + geom.topR) / 2 + (geom.insetL - geom.insetR) / 2}px`;
    label.style.opacity = String(state.reveal);
    label.style.filter = state.reveal > 0.98 ? 'none' : `blur(${((1 - state.reveal) * 3).toFixed(2)}px)`;
    label.style.transform = `translate(-50%, ${(3 * (1 - state.open)).toFixed(2)}px)`;

    fill.style.width = `${fillW}px`;
    thumb.style.left = `${left}px`;
    thumb.style.width = `${thumbW}px`;
    thumb.style.height = `${REST_H}px`;
    thumb.style.marginTop = `${-REST_H / 2}px`;

    const active = Math.round(state.display);
    ticks.forEach((el, i) => {
      const x = centerFor(i);
      const onThumb = x >= left + 0.5 && x <= right - 0.5;
      el.style.left = `${x}px`;
      el.dataset.on = onThumb ? 'thumb' : x <= fillW ? 'fill' : 'track';
      el.dataset.active = String(i === active && !onThumb);
    });

    track.setAttribute('aria-valuenow', String(active));
    track.setAttribute('aria-valuetext', `${lead} ${stops[active]}`);
  }

  /** 肩部开合；松手时顺带把数值滚到最近的整数档 */
  function animateOpen(to) {
    cancel('value'); // 键盘那段滑动让位给「开合 + 吸附」这条
    const fromOpen = state.open;
    const fromValue = state.display;
    const target = dragging ? fromValue : Math.round(state.value);
    if (!dragging) state.value = target;
    tween('open', {
      from: fromOpen,
      to,
      dur: 220,
      step: (e) => {
        state.open = fromOpen + (to - fromOpen) * e;
        if (!dragging) state.display = fromValue + (target - fromValue) * e;
        render();
      },
    });
  }

  function animateValue(to) {
    const from = state.display;
    state.value = to;
    tween('value', {
      from,
      to,
      dur: 220,
      step: (e) => {
        state.display = from + (to - from) * e;
        render();
      },
    });
  }

  function animateReveal(to) {
    const from = state.reveal;
    tween('reveal', {
      from,
      to,
      dur: to ? 132 : 90,
      delay: to ? 85 : 0, // 先让肩部长起来，标签再「显影」出来
      step: (e) => {
        state.reveal = from + (to - from) * e;
        render();
      },
    });
  }

  function animatePlateau(to) {
    const from = state.plateau;
    tween('plateau', {
      from,
      to,
      dur: 90,
      step: (e) => {
        state.plateau = from + (to - from) * e;
        render();
      },
    });
  }

  function syncReveal() {
    const want = dragging || state.focused ? 1 : 0;
    if (Math.abs(state.reveal - want) < 0.01) return;
    animateReveal(want);
  }

  /** 文字换了才重量宽度：平台宽度跟着文字走，肩部才不会把字挤到边上 */
  function syncLabel(force = false) {
    const text = stops[Math.round(state.value)];
    if (!force && levelEl.textContent === text) return;
    levelEl.textContent = text;
    // 交班动画：换个 key 重放 blur-in（CSS 里是 .re-swap）
    levelEl.classList.remove('re-swap');
    void levelEl.offsetWidth;
    levelEl.classList.add('re-swap');
    measure();
  }

  function measure() {
    const w = label.getBoundingClientRect().width;
    if (w <= 0) return;
    const target = plateauFor(w);
    if (Math.abs(target - state.plateauTarget) < 0.3) return;
    state.plateauTarget = target;
    animatePlateau(target);
  }
  state.plateauTarget = state.plateau;

  function commit(v, notify) {
    state.value = v;
    state.display = v;
    const i = Math.round(v);
    if (i !== notified) {
      notified = i;
      syncLabel();
      if (notify) onLevel?.(i);
    }
    render();
  }

  function valueFrom(clientX) {
    const box = track.getBoundingClientRect();
    if (!box.width) return state.value;
    const t = (clientX - box.left - RADIUS) / (box.width - RADIUS * 2);
    return clamp(t * last, 0, last);
  }

  track.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    root.dataset.dragging = 'true';
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* 指针捕获需要可信事件，拿不到就算了 */
    }
    track.focus({ preventScroll: true });
    commit(valueFrom(e.clientX), true);
    animateOpen(1);
    syncReveal();
    e.preventDefault();
  });

  track.addEventListener('pointermove', (e) => {
    if (dragging) commit(valueFrom(e.clientX), true);
  });

  function release(e) {
    if (!dragging) return;
    dragging = false;
    delete root.dataset.dragging;
    releasedAt = Date.now();
    try {
      if (track.hasPointerCapture?.(e.pointerId)) track.releasePointerCapture(e.pointerId);
    } catch {
      /* 同上 */
    }
    animateOpen(0);
    syncReveal();
  }
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);

  track.addEventListener('keydown', (e) => {
    const current = Math.round(state.value);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(last, current + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, current - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next == null || next === current) {
      if (next != null) e.preventDefault();
      return;
    }
    e.preventDefault();
    state.focused = true; // 键盘在动，把档位名亮出来
    syncReveal();
    notified = next;
    syncLabel();
    animateValue(next); // 先滑，再通知：paintThink 里的 set() 会被上面的早退挡住，不会打断这段
    onLevel?.(next);
  });

  // 键盘聚焦也把标签探出来（鼠标悬停 / 鼠标点进来都不算：静止就该是一条安静的胶囊，
  // 当前档位由气泡标题和下面的说明写着）。所以这里用 :focus-visible 区分来路。
  track.addEventListener('focus', () => {
    state.focused = track.matches?.(':focus-visible') ?? false;
    syncReveal();
  });
  track.addEventListener('blur', () => {
    state.focused = false;
    syncReveal();
  });

  // 气泡是 display:none 开的，塞进去那一刻量不到宽度；ResizeObserver 补上这次测量
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => measure()).observe(label);

  syncLabel(true);
  render();

  return {
    /** 外部状态变了（切模型 / 开关 / 打开气泡）：落到某一档 */
    set(i, { animate = false } = {}) {
      if (dragging) return; // 拖动时别抢位置
      const idx = clamp(Math.round(i), 0, last);
      // 位置本来就对：什么都不做。键盘跳档时会顺着这条路走一遍
      // （onLevel → paintThink → set），不能把刚起步的滑动掐掉。
      if (idx === Math.round(state.value)) return;
      notified = idx;
      if (animate) {
        syncLabel();
        animateValue(idx);
      } else {
        cancel('value');
        cancel('open');
        state.open = 0;
        syncLabel();
        commit(idx, false);
      }
    },
    index: () => Math.round(state.value),
    /** 刚松手（250ms 内）：外面的 click 别当成「点到气泡外面」把气泡关了 */
    justReleased: () => Date.now() - releasedAt < 250,
    /** 容器尺寸变了（气泡从隐藏到显示）重新量一次平台宽 */
    remeasure: measure,
  };
}
