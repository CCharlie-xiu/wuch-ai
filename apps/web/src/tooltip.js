// ─────────────────────────────────────────────────────────────────────────────
// 纯图标控件的悬浮提示：事件委托，聊天页、演示页、设置页共用一个气泡。
// 文案取 data-tip → title → aria-label；带文字的控件保持原生 title 不接管。
// title 读走后置空（不删），否则会冒出祖先元素的原生提示。
// 末尾的「（⌘[）」「（Esc）」这类快捷键单独渲染成键帽。
// ─────────────────────────────────────────────────────────────────────────────

const TARGET = 'button, a, [role="separator"], [data-tip]';
const SHOW_DELAY = 380;
const WARM_MS = 600; // 刚收起一个提示后，紧接着悬停下一个就不再等
const GAP = 8;
const EDGE = 8;
const KEY_RE = /^(.*?)[（(]((?:⌘|⇧|⌥|⌃|Ctrl|Alt|Shift|Esc|Enter|Tab)[^）)]*)[）)]$/;

let tip, timer, anchor, lastHide = 0;

function label(el) {
  if (el.title) {
    el.dataset.tip = el.title;
    el.title = '';
  }
  return el.dataset.tip || el.getAttribute('aria-label') || '';
}

function iconOnly(el) {
  if (el.dataset.tip !== undefined && !el.matches('button, a, [role="separator"]')) return true;
  return !/[\p{L}\p{N}]/u.test(el.textContent || '');
}

function ensure() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.id = 'ui-tip';
  return tip;
}

function fill(text) {
  const m = text.match(KEY_RE);
  tip.textContent = m ? m[1].trim() : text;
  if (m) {
    const k = document.createElement('kbd');
    k.textContent = m[2];
    tip.appendChild(k);
  }
}

function place(el) {
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const vw = window.innerWidth;
  const above = r.top - h - GAP >= EDGE;
  const top = above ? r.top - h - GAP : r.bottom + GAP;
  const cx = r.left + r.width / 2;
  const left = Math.min(Math.max(cx - w / 2, EDGE), vw - w - EDGE);
  tip.dataset.side = above ? 'top' : 'bottom';
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.style.setProperty('--arrow-x', `${Math.round(Math.min(Math.max(cx - left, 10), w - 10))}px`);
}

function show(el) {
  const text = label(el);
  if (!text || !el.isConnected) return;
  ensure();
  (document.fullscreenElement || document.body).appendChild(tip);
  fill(text);
  tip.classList.remove('show');
  place(el); // 读尺寸会强制样式计算，紧接着加 show 才有过渡
  el.setAttribute('aria-describedby', tip.id);
  tip.classList.add('show');
}

function hide() {
  clearTimeout(timer);
  if (anchor) anchor.removeAttribute('aria-describedby');
  if (tip?.classList.contains('show')) lastHide = performance.now();
  tip?.classList.remove('show');
  anchor = null;
}

function enter(el) {
  if (el === anchor) return;
  hide();
  if (el.getAttribute('aria-expanded') === 'true' || el.disabled) return;
  if (!iconOnly(el) || !label(el)) return;
  anchor = el;
  const wait = performance.now() - lastHide < WARM_MS ? 0 : SHOW_DELAY;
  timer = setTimeout(() => anchor === el && show(el), wait);
}

let inited = false;
export function initTooltips() {
  if (inited) return;
  inited = true;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.(TARGET);
    if (el) enter(el);
    else if (anchor) hide();
  });
  document.addEventListener('pointerout', (e) => {
    if (anchor && !anchor.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.(TARGET);
    if (el?.matches(':focus-visible')) enter(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
