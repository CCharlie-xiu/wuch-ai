import { defineComponent, str, enumOf } from '../define.js';
import { el, mdToHtml } from '../dom.js';
import { codeView } from '../code.js';
import { katexReady, loadKatex, renderTex } from '../katex.js';

// marked 只在浏览器里 import（import map 指到 /vendor/marked.js），没加载完之前先用 dom.js 的迷你版顶着。
// 模型写不进任意 markup：原始 HTML 一律当文字转义，链接只放行 http(s) / mailto / 页内锚点，
// 图片只给链接不直接加载。代码围栏和公式先输出占位，再换成 codeView / KaTeX。
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i;

let md = null;
let loading = null;

const mathPlaceholder = (tex, display) => `<span class="md-math" data-display="${display ? 1 : 0}">${esc(tex)}</span>`;

const loadMarked = () =>
  (loading ||= import('marked').then(({ Marked }) => {
    md = new Marked({ gfm: true, breaks: true });
    md.use({
      extensions: [
        {
          name: 'blockMath',
          level: 'block',
          start: (src) => src.match(/^\$\$/m)?.index,
          tokenizer(src) {
            const m = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src);
            if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() };
          },
          renderer: (t) => `<div class="md-math-block">${mathPlaceholder(t.text, true)}</div>`,
        },
        {
          name: 'inlineMath',
          level: 'inline',
          start: (src) => src.indexOf('$'),
          // 开头 $ 后不接空白、结尾 $ 前不接空白且后面不是数字：「$5 到 $10」不会被当成公式
          tokenizer(src) {
            const m = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
            if (m) return { type: 'inlineMath', raw: m[0], text: m[1] };
          },
          renderer: (t) => mathPlaceholder(t.text, false),
        },
      ],
      renderer: {
        html: (t) => esc(t.text),
        heading({ tokens, depth }) {
          const lvl = Math.min(depth + 2, 6);
          return `<h${lvl}>${this.parser.parseInline(tokens)}</h${lvl}>`;
        },
        link({ href, tokens }) {
          const text = this.parser.parseInline(tokens);
          return SAFE_HREF.test(href || '') ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${text}</a>` : text;
        },
        image: ({ href, text }) => (SAFE_HREF.test(href || '') ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(text || href)}</a>` : esc(text)),
        code: ({ text, lang }) => `<pre class="md-code" data-lang="${esc((lang || '').split(/\s/)[0])}"><code>${esc(text)}</code></pre>`,
      },
    });
    return md;
  }));

function paintMath(n) {
  for (const s of n.querySelectorAll('.md-math')) {
    if (s.dataset.done) continue;
    if (renderTex(s.textContent, s, s.dataset.display === '1')) s.dataset.done = '1';
  }
}

function paint(n, src) {
  if (!md) {
    n.innerHTML = mdToHtml(src);
    return;
  }
  n.innerHTML = md.parse(String(src ?? ''));
  for (const pre of n.querySelectorAll('pre.md-code')) pre.replaceWith(codeView(pre.textContent, pre.dataset.lang));
  if (!n.querySelector('.md-math')) return;
  if (katexReady()) paintMath(n);
  else loadKatex().then(() => paintMath(n));
}

export default defineComponent({
  name: 'MarkDownRenderer',
  group: 'Content',
  description:
    '渲染 Markdown 文本块：标题、粗斜体、有序 / 无序 / 任务列表、表格、引用、分隔线、带语法高亮的代码围栏、行内 $...$ 与独占一行 $$...$$ 公式（字符串里反斜杠写两次）',
  skeleton: { lines: 4 },
  params: [
    str('markdown', { required: true }),
    enumOf('variant', ['clear', 'sunk'], { default: 'clear' }),
  ],
  render: {
    create(p) {
      const n = el('div', 'md');
      n.dataset.variant = p.variant || 'clear';
      n.__src = p.markdown;
      paint(n, p.markdown);
      if (!md) loadMarked().then(() => paint(n, n.__src));
      return n;
    },
    updates: ['markdown', 'variant'],
    update(n, p) {
      n.dataset.variant = p.variant || 'clear';
      if (n.__src === p.markdown) return;
      n.__src = p.markdown;
      // 流式 Markdown 会越写越长：marked + KaTeX 全量重解析很贵，合并到下一帧再刷
      if (n.__mdRaf) return;
      n.__mdRaf = requestAnimationFrame(() => {
        n.__mdRaf = 0;
        paint(n, n.__src);
      });
    },
  },
  markdown: (p) => p.markdown ?? '',
  css: `
.md { font-size: 13.5px; line-height: 1.7; min-width: 0; overflow-wrap: anywhere; }
.md[data-variant="sunk"] { background: var(--ui-band, rgba(17,24,39,.035)); border: 0; border-radius: 11px; padding: 12px 14px; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md h3, .md h4, .md h5, .md h6 { margin: 14px 0 6px; font-size: 14px; line-height: 1.4; }
.md h3 { font-size: 15.5px; }
.md p { margin: 0 0 8px; }
.md ul, .md ol { margin: 0 0 8px; padding-left: 20px; }
.md li { margin: 2px 0; }
.md li > ul, .md li > ol { margin: 2px 0 0; }
.md li:has(> input[type="checkbox"]) { list-style: none; margin-left: -18px; }
.md input[type="checkbox"] { margin: 0 6px 0 0; vertical-align: -1px; }
.md a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--ui-line-strong, rgba(17,24,39,.1)); }
.md :not(pre) > code { font-family: var(--mono); background: var(--ui-band-strong, rgba(17,24,39,.07)); border-radius: 4px; padding: 1px 4px; font-size: 12px; }
/* 引用块 / 分隔线 / 表格：都在块内部，用发丝线（②层） */
.md blockquote { margin: 0 0 8px; padding: 2px 0 2px 12px; border-left: 2px solid var(--ui-line-strong, rgba(17,24,39,.1)); color: var(--ui-ink-2); }
.md hr { border: 0; border-top: 1px solid var(--ui-line, rgba(17,24,39,.06)); margin: 14px 0; }
.md table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 0 0 10px; font-size: 12.5px; }
.md th, .md td { border: 0; border-bottom: 1px solid var(--ui-line, rgba(17,24,39,.06)); padding: 6px 12px; text-align: left; }
.md th { background: transparent; font-weight: 600; color: var(--ui-ink-3); font-size: 11px; letter-spacing: .02em; border-bottom-color: var(--ui-line-strong, rgba(17,24,39,.1)); }
.md .code-block { margin: 0 0 10px; }
.md-math-block { margin: 0 0 10px; overflow-x: auto; overflow-y: hidden; padding: .3em 2px; }
.md-math-block .katex-display { margin: 0; }
.md .md-math:not([data-done]) { font-family: var(--mono); font-size: 12px; }
`,
});
