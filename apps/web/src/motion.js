// ─────────────────────────────────────────────────────────────────────────────
// 切换动画：管两条路。
//
//   ① 页面级（跨页、设置页、历史面板）→ View Transitions API。
//      浏览器不支持这个 API、或用户开了「减少动效」时，切换照常发生、只是没有
//      过渡 —— 调用点不需要自己写分支。
//      跨文档那一半不经过这里，是 CSS 的 @view-transition { navigation: auto }。
//   ② 内容级（检视器页签、设置页页签）→ CSS 类动画。页签点得太频繁，
//      整页快照会拖慢手感，所以只给新内容播一段淡入上移。
//
// 两个前提，破坏任一条 View Transition 就静默消失：
//   · 静态服务给 HTML 回的必须是 no-cache 而不是 no-store
//     （apps/server/index.mjs 的 serveStatic —— 规范要求导航响应可缓存）；
//   · 同一时刻页面上不能有两个元素挂同一个 view-transition-name。
//
// 沙箱宿主 iframe（#runner）带 hidden、不在渲染树里，快照拍不到它，
// 所以不需要为它做任何排除。
// ─────────────────────────────────────────────────────────────────────────────

const supported =
  typeof document !== 'undefined' && typeof document.startViewTransition === 'function';

/** 用户没有要求减少动效 */
export const motionAllowed = () =>
  !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** 这个浏览器能不能做 View Transition */
export const vtSupported = supported;

/**
 * 把一次 DOM 切换包进 View Transition。
 * @param {() => void} update 同步改 DOM 的函数
 * @returns {boolean} 是否真的走了动画
 */
export function vt(update) {
  if (!supported || !motionAllowed()) {
    update();
    return false;
  }
  const t = document.startViewTransition(update);
  // 过渡被跳过（连点、标签页在后台）时别把 rejection 冒到 console
  t.finished.catch(() => {});
  return true;
}

/**
 * 重放一次 CSS 进入动画：摘掉类 → 强制重排 → 加回去。
 * 元素上已经带着这个类时，不这么做动画不会重播。
 */
export function replayIn(node, cls = 'pane-in') {
  if (!node || !motionAllowed()) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}
