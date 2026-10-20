import { defineComponent, str, enumOf } from '../define.js';
import { el } from '../dom.js';
import { katexReady, loadKatex, repairTex, renderTex } from '../katex.js';

// 流式时 TeX 常常写到一半（括号没闭合），解析失败先保留上一次画好的；
// 停笔一段时间仍然失败，才退回显示原文。
const SETTLE_MS = 800;

function draw(n, p) {
  const display = p.display !== 'inline';
  n.className = display ? 'formula' : 'formula inline';
  n.__raw.textContent = repairTex(p.tex);
  clearTimeout(n.__timer);
  if (!katexReady()) return;
  if (renderTex(p.tex, n.__math, display)) {
    n.__ok = true;
    n.dataset.state = 'ok';
    return;
  }
  if (!n.__ok) n.dataset.state = 'raw';
  n.__timer = setTimeout(() => (n.dataset.state = 'raw'), SETTLE_MS);
}

export default defineComponent({
  name: 'Formula',
  group: 'Content',
  description:
    '数学公式 / 函数表达式，LaTeX 写法（KaTeX 渲染）。字符串里的反斜杠要写两次：Formula("f(x) = \\\\frac{1}{1 + e^{-x}}")；display 默认 block 独占一行居中，inline 用于和文字并排',
  skeleton: { h: 44 },
  params: [
    str('tex', { required: true }),
    str('label'),
    enumOf('display', ['block', 'inline'], { default: 'block' }),
  ],
  render: {
    create(p) {
      const display = p.display !== 'inline';
      const n = el(display ? 'div' : 'span');
      n.__math = el(display ? 'div' : 'span', 'formula-math');
      n.__raw = el('code', 'formula-raw');
      n.__label = el('span', 'formula-label', p.label ?? '');
      n.append(n.__math, n.__raw, n.__label);
      n.dataset.state = 'raw';
      n.__props = p;
      draw(n, p);
      if (!katexReady()) loadKatex().then(() => draw(n, n.__props));
      return n;
    },
    updates: ['tex', 'label'],
    update(n, p) {
      n.__props = p;
      n.__label.textContent = p.label ?? '';
      draw(n, p);
    },
  },
  markdown: (p) => (p.display === 'inline' ? `$${p.tex ?? ''}$` : `$$\n${p.tex ?? ''}\n$$`) + (p.label ? `\n\n${p.label}` : ''),
  css: `
.formula { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 4px 0; max-width: 100%; }
.formula .formula-math { width: 100%; text-align: center; overflow-x: auto; overflow-y: hidden; padding: .3em 2px; }
.formula .katex-display { margin: 0; }
.formula .katex { font-size: 1.15em; color: var(--text); }
.formula.inline { display: inline-flex; flex-direction: row; align-items: baseline; padding: 0; }
.formula.inline .formula-math { width: auto; overflow: visible; padding: 0; }
.formula.inline .katex { font-size: 1.05em; }
.formula-raw { display: none; font-family: var(--mono); font-size: 12.5px; color: #3f3f46; white-space: pre-wrap; word-break: break-all; }
.formula[data-state="raw"] .formula-math { display: none; }
.formula[data-state="raw"] .formula-raw { display: inline; }
.formula-label { font-size: 12px; color: var(--ui-ink-3); }
.formula-label:empty { display: none; }
`,
});
