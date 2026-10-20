// ─────────────────────────────────────────────────────────────────────────────
// 思考过程折叠块（移植自 xmkf-rpa-platform 的 ThinkingReasoning，原型是 aicss Thinking + Reasoning）
//
//   思考中：标题流光，正文边到边滚到底，底部渐隐
//   思考完：收成「已思考 N 秒」，点标题展开 / 收起，展开后可滚动回看
//
// 流式时 reasoning 可能一口气几十 KB：不能每个 token 都改 textContent / 强制布局，
// 否则主线程被 DOM 更新占满，思考字数停住、画布也画不出来，等一会儿才整页蹦出来。
// ─────────────────────────────────────────────────────────────────────────────

const MAX_H = 180;
const FADE = 16;

const CHEVRON =
  '<svg class="ai-tr__chevron" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m4.5 15.75 7.5-7.5 7.5 7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createThinking() {
  const root = document.createElement('div');
  root.className = 'ai-tr';
  root.innerHTML = `
    <button type="button" class="ai-tr__header" aria-expanded="true" aria-label="展开或收起思考过程">
      <span class="ai-tr__label ai-tr__label--shimmer">思考中…</span>
    </button>
    <div class="ai-tr__collapsible">
      <div class="ai-tr__inner">
        <div class="ai-tr__viewport" style="max-height:${MAX_H}px"><pre class="ai-tr__prose"></pre></div>
      </div>
    </div>`;
  const header = root.querySelector('.ai-tr__header');
  const collapsible = root.querySelector('.ai-tr__collapsible');
  const viewport = root.querySelector('.ai-tr__viewport');
  const prose = root.querySelector('.ai-tr__prose');

  const startedAt = Date.now();
  let text = '';
  let done = false;
  let open = false;
  let dirty = false;
  let raf = 0;

  function mask(top, bottom) {
    const m = text.trim()
      ? `linear-gradient(to bottom, transparent 0, #000 ${top ? FADE : 0}px, #000 calc(100% - ${bottom ? FADE : 0}px), transparent 100%)`
      : 'none';
    viewport.style.webkitMaskImage = m;
    viewport.style.maskImage = m;
  }

  function syncFade() {
    if (done && open) {
      mask(viewport.scrollTop > 1, viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1);
    } else {
      mask(false, true);
    }
  }

  function paint() {
    raf = 0;
    if (!dirty) return;
    dirty = false;
    prose.textContent = text;
    if (!done) viewport.scrollTop = viewport.scrollHeight;
    syncFade();
  }

  function schedulePaint() {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(paint);
  }

  function setExpanded(v) {
    header.setAttribute('aria-expanded', String(v));
    collapsible.classList.toggle('ai-tr__collapsible--collapsed', !v);
    viewport.classList.toggle('ai-tr__viewport--scroll', done && v);
  }

  viewport.addEventListener('scroll', syncFade);
  header.addEventListener('click', () => {
    if (!done) return;
    open = !open;
    if (open) viewport.scrollTop = 0;
    setExpanded(open);
    syncFade();
  });

  return {
    el: root,
    append(chunk) {
      if (done) return;
      text += chunk;
      schedulePaint();
    },
    finish() {
      if (done) return;
      done = true;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      // 收尾前把积压的正文刷干净，避免「已思考」但内容少一截
      if (dirty) paint();
      const s = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      header.classList.add('ai-tr__header--clickable');
      header.innerHTML = `<span class="ai-tr__label">已<span class="ai-tr__verb">思考</span> ${s} 秒</span>${CHEVRON}`;
      setExpanded(false);
      syncFade();
    },
  };
}
