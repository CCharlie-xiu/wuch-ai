// ─────────────────────────────────────────────────────────────────────────────
// 外壳交互：缩放、全屏、复制编译产物、右侧悬浮面板（拖宽 / 收起）、来源下拉。
// 聊天页与演示页共用 —— 两页的 DOM 结构一致（见 apps/web/*.html）。
// 缺哪个控件就跳过哪个，不报错。
// ─────────────────────────────────────────────────────────────────────────────

import { initTooltips } from './tooltip.js';
import { mountBlobLogos } from './blob-logo.js';

const $ = (s) => document.querySelector(s);

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// 复制：安全上下文用 Clipboard API，否则退回复制命令
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

export function createShell({ session, inspector, toast = () => {} }) {
  initTooltips();
  mountBlobLogos();
  let zi = ZOOMS.indexOf(1);

  function applyZoom() {
    const z = ZOOMS[zi];
    document.documentElement.style.setProperty('--stage-zoom', String(z));
    const label = $('#zoom-reset');
    if (label) label.textContent = Math.round(z * 100) + '%';
  }
  function zoom(step) {
    zi = Math.min(Math.max(zi + step, 0), ZOOMS.length - 1);
    applyZoom();
  }
  function resetZoom() {
    zi = ZOOMS.indexOf(1);
    applyZoom();
  }

  $('#zoom-in')?.addEventListener('click', () => zoom(1));
  $('#zoom-out')?.addEventListener('click', () => zoom(-1));
  $('#zoom-reset')?.addEventListener('click', resetZoom);
  $('#view-fit')?.addEventListener('click', () => {
    resetZoom();
    inspector?.switchTab('stage');
    toast('已适配宽度');
  });
  $('#view-reload')?.addEventListener('click', () => {
    inspector?.switchTab('stage');
    inspector?.refresh();
    toast('已重新渲染当前界面');
  });

  // 全屏：展示区全屏 / 整页全屏
  function toggleFullscreen(target) {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }
    const p = target?.requestFullscreen?.();
    if (p?.catch) p.catch(() => toast('这个浏览器不允许全屏'));
  }
  $('#view-fullscreen')?.addEventListener('click', () => toggleFullscreen($('#panel')));
  $('#top-fullscreen')?.addEventListener('click', () => toggleFullscreen(document.documentElement));
  // 谁进的全屏，谁换成「退出全屏」图标；另一个保持原样
  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement;
    const owner = fs === document.documentElement ? $('#top-fullscreen') : fs ? $('#view-fullscreen') : null;
    for (const b of document.querySelectorAll('.fs-btn')) {
      const on = b === owner;
      b.classList.toggle('is-fs', on);
      b.title = on ? '退出全屏（Esc）' : b.dataset.fsTitle;
      b.setAttribute('aria-label', on ? '退出全屏' : b.dataset.fsTitle);
    }
  });

  $('#top-copy')?.addEventListener('click', async () => {
    const code = session?.snapshot?.().code || '';
    if (!code) return toast('还没有编译产物');
    await copy(code);
    toast(`已复制编译产物（${code.length} 字节）`);
  });

  // 右侧悬浮面板：拖左缘改 --chat-w，收起 / 展开切 .chat-collapsed；两者都记在 localStorage
  const shell = $('.shell');
  const root = document.documentElement;
  const SHEET_GAP = 12; // 与 css 的 --sheet-gap 一致
  const savedW = Number(localStorage.getItem('openui.chatW'));
  if (savedW >= 320) root.style.setProperty('--chat-w', savedW + 'px');

  function setChatOpen(open) {
    shell?.classList.toggle('chat-collapsed', !open);
    localStorage.setItem('openui.chatOpen', open ? '1' : '0');
  }
  setChatOpen(localStorage.getItem('openui.chatOpen') !== '0');
  $('#chat-collapse')?.addEventListener('click', () => setChatOpen(false));
  $('#chat-fab')?.addEventListener('click', () => setChatOpen(true));

  const grip = $('#pane-grip');
  if (grip) {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      shell?.classList.add('resizing');
      let w = 0;
      const move = (ev) => {
        const max = Math.round(window.innerWidth * 0.72);
        w = Math.min(Math.max(window.innerWidth - SHEET_GAP - ev.clientX, 320), max);
        root.style.setProperty('--chat-w', w + 'px');
      };
      const stop = () => {
        shell?.classList.remove('resizing');
        if (w) localStorage.setItem('openui.chatW', String(w));
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', stop);
        grip.removeEventListener('pointercancel', stop);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', stop);
      grip.addEventListener('pointercancel', stop);
    });
  }

  // 来源下拉（只有聊天页有）
  const srcBtn = $('#sources-btn');
  const srcMenu = $('#sources-menu');
  if (srcBtn && srcMenu) {
    // 跟着按钮摆：左边对齐按钮，弹在按钮上方；贴右边时往左收，不出窗口
    const placeSrcMenu = () => {
      const bb = srcBtn.getBoundingClientRect();
      const w = srcMenu.offsetWidth || 176;
      srcMenu.style.left = Math.round(Math.max(8, Math.min(bb.left, window.innerWidth - w - 8))) + 'px';
      srcMenu.style.bottom = Math.round(window.innerHeight - bb.top + 8) + 'px';
    };
    srcBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = srcMenu.classList.toggle('hidden');
      if (!open) placeSrcMenu();
      srcBtn.setAttribute('aria-expanded', String(!open));
    });
    window.addEventListener('resize', () => !srcMenu.classList.contains('hidden') && placeSrcMenu());
    for (const b of srcMenu.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        $('#sources-label').textContent = b.dataset.src;
        // 筛过来源时把标记稍微提亮一点，提示「这一轮不是全部数据」
        srcBtn.classList.toggle('filtered', b.dataset.src !== '全部来源');
        for (const x of srcMenu.querySelectorAll('button')) {
          const tick = x.querySelector('.tick');
          if (tick) tick.remove();
        }
        b.insertAdjacentHTML('beforeend', '<span class="tick">✓</span>');
        srcMenu.classList.add('hidden');
        srcBtn.setAttribute('aria-expanded', 'false');
        toast(`来源：${b.dataset.src}`);
      });
    }
    document.addEventListener('click', () => {
      srcMenu.classList.add('hidden');
      srcBtn.setAttribute('aria-expanded', 'false');
    });
  }

  applyZoom();
  return { zoom, resetZoom, applyZoom, toggleFullscreen, setChatOpen };
}
