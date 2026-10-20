// ─────────────────────────────────────────────────────────────────────────────
// 工具调用审批：挂在输入框上方的非模态询问卡。
// 交互参考 aicss Approval Card 的「输入旁暂停询问」位置；Pro 源码不碰，按 style-tokens 自绘。
// ─────────────────────────────────────────────────────────────────────────────

const RISK = {
  low: { label: '低风险', tone: 'ok' },
  medium: { label: '中风险', tone: 'warn' },
  high: { label: '高风险', tone: 'bad' },
};

const ICONS = {
  web_search:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  fetch_url:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"/><path d="M3 12h18M12 3c2.5 2.8 3.8 5.8 3.8 9S14.5 18.2 12 21c-2.5-2.8-3.8-5.8-3.8-9S9.5 5.8 12 3z"/></svg>',
};

let busy = null;
let host = null;

function ensureHost() {
  if (host?.isConnected) return host;
  host = document.getElementById('tool-ask-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'tool-ask-host';
    host.className = 'tool-ask-host';
  }
  const composer = document.getElementById('composer');
  if (composer?.parentNode) {
    if (host.parentNode !== composer.parentNode || host.nextElementSibling !== composer) {
      composer.parentNode.insertBefore(host, composer);
    }
  } else if (!host.isConnected) {
    document.body.appendChild(host);
  }
  return host;
}

/**
 * @param {{ name: string, label: string, detail?: string, risk?: string, summary?: string, signal?: AbortSignal }} opts
 * @returns {Promise<boolean>}
 */
export function askToolApproval(opts) {
  if (typeof document === 'undefined') return Promise.resolve(true);
  if (opts.signal?.aborted) return Promise.resolve(false);
  if (busy) return busy.then(() => askToolApproval(opts));

  busy = new Promise((resolve) => {
    const risk = RISK[opts.risk] || RISK.medium;
    const root = document.createElement('div');
    root.className = 'tool-ask';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', `工具授权：${opts.label}`);
    root.setAttribute('aria-labelledby', 'tool-ask-title');

    root.innerHTML = `
      <div class="tool-ask__card">
        <div class="tool-ask__head">
          <span class="tool-ask__icon" aria-hidden="true">${ICONS[opts.name] || ICONS.fetch_url}</span>
          <div class="tool-ask__copy">
            <div class="tool-ask__title-row">
              <h3 id="tool-ask-title" class="tool-ask__title">允许调用「${esc(opts.label)}」？</h3>
              <span class="tool-ask__risk" data-tone="${risk.tone}">${risk.label}</span>
            </div>
            <p class="tool-ask__summary">${esc(opts.summary || '模型想用这个联网工具继续回答。')}</p>
          </div>
        </div>
        ${opts.detail ? `<div class="tool-ask__detail"><span class="tool-ask__k">${opts.name === 'web_search' ? '关键词' : '网址'}</span><code>${esc(opts.detail)}</code></div>` : ''}
        <div class="tool-ask__foot">
          <span class="tool-ask__hint">只读 · 不挡其它操作 · Esc 拒绝</span>
          <div class="tool-ask__actions">
            <button type="button" class="tool-ask__ghost" data-act="deny">拒绝</button>
            <button type="button" class="tool-ask__primary" data-act="allow">允许</button>
          </div>
        </div>
      </div>`;

    const finish = (ok) => {
      if (!root.isConnected) return;
      opts.signal?.removeEventListener('abort', onAbort);
      root.classList.add('tool-ask--out');
      const done = () => {
        root.remove();
        document.removeEventListener('keydown', onKey, true);
        if (!host?.childElementCount) host?.classList.remove('has-ask');
        busy = null;
        resolve(ok);
      };
      const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160;
      if (!ms) return done();
      root.addEventListener('transitionend', done, { once: true });
      setTimeout(done, ms + 40);
    };

    const onAbort = () => finish(false);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 只在焦点落在审批卡内，或焦点不在可编辑区时，才用 Esc 拒绝
      const t = e.target;
      const editing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (editing && !root.contains(t)) return;
      e.preventDefault();
      finish(false);
    };

    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'allow') finish(true);
      else if (act === 'deny') finish(false);
    });

    const slot = ensureHost();
    slot.classList.add('has-ask');
    slot.replaceChildren(root);
    document.addEventListener('keydown', onKey, true);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    requestAnimationFrame(() => root.classList.add('tool-ask--in'));
    // 不抢输入焦点：用户仍可继续改草稿；需要操作时点按钮即可
  });

  return busy;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
