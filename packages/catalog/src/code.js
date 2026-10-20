// ─────────────────────────────────────────────────────────────────────────────
// 代码框共用底座：CodeBlock 与 MarkDownRenderer 里的代码围栏长得一样、走同一套高亮。
//
// highlight.js 只在浏览器里 import（import map 把 @highlightjs/cdn-assets/ 指到 /vendor/hljs/），
// 核心与每种语言各一个文件，用到哪种语言才取哪种。没加载完或语言不认识时先显示纯文本。
// 高亮结果是 highlight.js 转义过的 HTML，模型写不进任意 markup。
// ─────────────────────────────────────────────────────────────────────────────

import { el, icon } from './dom.js';

const ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yml: 'yaml', html: 'xml', svg: 'xml', vue: 'xml',
  'c++': 'cpp', cc: 'cpp', hpp: 'cpp', h: 'c',
  rs: 'rust', golang: 'go', kt: 'kotlin', rb: 'ruby', cs: 'csharp', 'c#': 'csharp',
  md: 'markdown', ps1: 'powershell', dockerfile: 'dockerfile', jsonc: 'json', patch: 'diff',
  objc: 'objectivec', tex: 'latex', proto: 'protobuf', tf: 'hcl',
};
const PLAIN = new Set(['', 'text', 'plain', 'plaintext', 'txt', 'output', 'log']);

/** 模型写的语言名 → highlight.js 的语言文件名；纯文本返回 '' */
export const hljsName = (lang) => {
  const k = String(lang ?? '').trim().toLowerCase();
  if (PLAIN.has(k) || !/^[a-z0-9+#-]{1,24}$/.test(k)) return '';
  return ALIASES[k] || k;
};

let hljs = null;
let core = null;
const langs = new Map(); // 名字 → Promise<boolean>

const loadCore = () => (core ||= import('@highlightjs/cdn-assets/es/core.min.js').then((m) => (hljs = m.default)));

/** 加载某种语言的语法；不认识的语言（404）记为 false，不重复请求 */
export function loadLang(name) {
  if (!name) return Promise.resolve(false);
  if (!langs.has(name)) {
    langs.set(
      name,
      loadCore()
        .then(() => (hljs.getLanguage(name) ? null : import(`@highlightjs/cdn-assets/es/languages/${name}.min.js`)))
        .then((m) => {
          if (m) hljs.registerLanguage(name, m.default);
          return true;
        })
        .catch(() => false)
    );
  }
  return langs.get(name);
}

/** 已加载就同步给出高亮 HTML，否则返回 null */
export function highlightSync(code, name) {
  if (!hljs || !name || !hljs.getLanguage(name)) return null;
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/**
 * 一个代码框：语言标签 + 文件名 + 复制按钮 + 高亮代码。
 * 返回元素，元素上的 __set(code, lang, filename) 原位更新（流式时代码逐渐变长）。
 */
export function codeView(code, lang, filename) {
  const n = el('div', 'code-block');
  const head = el('div', 'code-head');
  const langEl = el('span', 'code-lang');
  const fileEl = el('span', 'code-file');
  const btn = el('button', 'code-copy');
  btn.type = 'button';
  btn.title = '复制';
  btn.appendChild(icon('copy', 'icon sm'));
  btn.addEventListener('click', () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(n.__code).then(() => {
      btn.replaceChildren(icon('check', 'icon sm'));
      btn.classList.add('done');
      clearTimeout(btn.__t);
      btn.__t = setTimeout(() => {
        btn.replaceChildren(icon('copy', 'icon sm'));
        btn.classList.remove('done');
      }, 1500);
    });
  });
  head.append(langEl, fileEl, btn);
  const pre = el('pre');
  const codeEl = el('code', 'hljs');
  pre.appendChild(codeEl);
  n.append(head, pre);

  const paint = () => {
    const html = highlightSync(n.__code, n.__name);
    if (html == null) codeEl.textContent = n.__code;
    else codeEl.innerHTML = html;
  };
  n.__set = (c, l, f) => {
    n.__code = String(c ?? '').replace(/\n$/, '');
    n.__name = hljsName(l);
    langEl.textContent = String(l ?? '').trim() || 'text';
    fileEl.textContent = f || '';
    paint();
    if (n.__name && !(hljs && hljs.getLanguage(n.__name))) {
      const want = n.__name;
      loadLang(want).then((ok) => ok && n.__name === want && paint());
    }
  };
  n.__set(code, lang, filename);
  return n;
}

export const CODE_CSS = `
/* 代码是块（①）：底色划界，不描边。放在 Card 里时由 Card 统一接管底色 */
.code-block { border: 0; border-radius: 11px; overflow: hidden; background: var(--ui-band, rgba(17,24,39,.035)); min-width: 0; }
.card .code-block { background: transparent; border-radius: 0; }
.code-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--ui-line, rgba(17,24,39,.06)); }
.code-lang { font-family: var(--mono); font-size: 11px; color: var(--ui-ink-3); }
.code-file { font-family: var(--mono); font-size: 11px; color: var(--ui-ink-3); }
.code-file:empty { display: none; }
.code-copy { margin-left: auto; background: transparent; border: 0; border-radius: 6px; padding: 4px; color: var(--ui-ink-3); cursor: pointer; display: grid; place-items: center; }
.code-copy:hover { color: var(--text); background: var(--ui-band-strong, rgba(17,24,39,.07)); }
.code-copy.done { color: var(--ok); }
.code-block pre { margin: 0; padding: 12px 14px; overflow: auto; max-height: 520px; }
.code-block code { font-family: var(--mono); font-size: 12.5px; line-height: 1.6; color: #24292f; white-space: pre; tab-size: 2; }
.hljs-keyword, .hljs-doctag, .hljs-template-tag, .hljs-template-variable, .hljs-type, .hljs-variable.language_ { color: #cf222e; }
.hljs-title, .hljs-title.class_, .hljs-title.function_ { color: #8250df; }
.hljs-attr, .hljs-attribute, .hljs-literal, .hljs-meta, .hljs-number, .hljs-operator, .hljs-variable, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id { color: #0550ae; }
.hljs-regexp, .hljs-string, .hljs-meta .hljs-string { color: #0a3069; }
.hljs-built_in, .hljs-symbol, .hljs-bullet { color: #953800; }
.hljs-comment, .hljs-code, .hljs-formula { color: #6e7781; font-style: italic; }
.hljs-name, .hljs-quote, .hljs-selector-tag, .hljs-selector-pseudo { color: #116329; }
.hljs-section { color: #0550ae; font-weight: 600; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
.hljs-addition { color: #116329; background: #dafbe1; }
.hljs-deletion { color: #82071e; background: #ffebe9; }
`;
