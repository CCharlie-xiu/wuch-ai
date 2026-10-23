// ─────────────────────────────────────────────────────────────────────────────
// 输入框周围的气泡（+ 菜单 / 来源 / 模型 / 思考强度 / 版本）同一时刻只开一个，
// 开合都走同一段「抽纸」动画。
//
// 为什么不用「点外面就关」那套：每个触发按钮的 click 都 stopPropagation，
// 打开 B 的时候 document 上的监听收不到那次点击，A 就一直开着 —— 两个气泡叠在一起。
// 这里改成打开时广播一次，其余气泡听见就自己关，和事件是否冒泡无关。
//
// 为什么不用纯 CSS：`.hidden` 是 display:none，一加上就没了，关闭永远动不起来。
// 所以关闭要「先播动画、再藏」，这段时序只能在 JS 里。
// ─────────────────────────────────────────────────────────────────────────────

const EVT = 'popover:open';

/** 和 CSS 里 .pop-anim 的过渡时长对齐；改一边要改另一边（现在都是 320ms） */
const ANIM_MS = 320;

const timers = new WeakMap();

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 打开自己之前喊一声：别的气泡会关掉 */
export function announcePopover(el) {
  document.dispatchEvent(new CustomEvent(EVT, { detail: el }));
}

/** 别的气泡打开时关掉自己；el 传自己的菜单节点 */
export function closeOnOtherPopover(el, close) {
  document.addEventListener(EVT, (e) => {
    if (e.detail !== el) close();
  });
}

/**
 * 是不是开着。
 * 不能看 `.hidden` —— 关闭动画期间它还没加上，这时用户再点一下会被当成「还开着」。
 */
export function isPopoverOpen(el) {
  return !!el && el.dataset.pop === 'open';
}

/**
 * 打开：先把起始态（压扁 + 透明）落地，再加 .pop-in 触发过渡。
 * 少了强制重排那一步，浏览器会把两次 class 变更合并成一次，动画根本不播。
 */
export function openPopover(el) {
  if (!el) return;
  const t = timers.get(el);
  if (t) {
    clearTimeout(t);
    timers.delete(el);
  }
  el.classList.add('pop-anim');
  el.classList.remove('hidden');
  el.dataset.pop = 'open';
  el.classList.remove('pop-in');
  void el.offsetWidth;
  el.classList.add('pop-in');
}

/**
 * 关闭：回抽 → 等动画走完再藏。
 * 期间又被打开的话，定时器里会发现 pop 又变回 open，就不藏了。
 */
export function closePopover(el, { immediate = false } = {}) {
  if (!el) return;
  const wasOpen = el.dataset.pop === 'open';
  delete el.dataset.pop;
  el.classList.remove('pop-in');
  // 本来就没开：直接藏，别再排一次定时器（"点外面就关" 的监听会每次点击都调过来）
  if (!wasOpen) {
    el.classList.add('hidden');
    return;
  }
  if (immediate || reducedMotion()) {
    el.classList.add('hidden');
    return;
  }
  const t = timers.get(el);
  if (t) clearTimeout(t);
  timers.set(
    el,
    setTimeout(() => {
      timers.delete(el);
      if (el.dataset.pop === 'open') return;
      el.classList.add('hidden');
    }, ANIM_MS),
  );
}

/** 开→关，关→开；返回打开后的状态 */
export function togglePopover(el) {
  if (isPopoverOpen(el)) {
    closePopover(el);
    return false;
  }
  openPopover(el);
  return true;
}
