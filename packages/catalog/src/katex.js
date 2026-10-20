// ─────────────────────────────────────────────────────────────────────────────
// 公式共用的 KaTeX 底座：Formula 与 MarkDownRenderer 里的 $...$ / $$...$$ 都走这里。
//
// katex 只在浏览器里 import（页面 import map 指到 /vendor/katex/katex.mjs），
// 样式表与字体在它旁边，首次用到时挂一次 <link>。服务端 import 目录时不会加载它。
// ─────────────────────────────────────────────────────────────────────────────

let katex = null;
let loading = null;

export const katexReady = () => !!katex;

export const loadKatex = () =>
  (loading ||= import('katex').then((m) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('katex.min.css', import.meta.resolve('katex')).href;
    document.head.appendChild(link);
    return (katex = m.default);
  }));

// OpenUI Lang 字符串按 JS 规则转义，模型漏写双反斜杠时 \frac \theta \neq 会被吃成控制字符。
// 控制字符后面紧跟字母时几乎只可能是这种情况，还原成命令；\n 只认常见命令，免得误伤真正的换行。
export const repairTex = (s) =>
  String(s ?? '')
    .replace(/[\f\t\r\b\v](?=[a-zA-Z])/g, (c) => '\\' + { '\f': 'f', '\t': 't', '\r': 'r', '\b': 'b', '\v': 'v' }[c])
    .replace(/\n(?=(abla|eq|e|u|ot|eg|i|ewline|leq|geq|mid|parallel|subseteq|supseteq|exists|earrow|warrow)(?![a-zA-Z]))/g, '\\n');

/** 把 tex 画进 target（会清空 target）。katex 还没加载或解析失败返回 false，target 不动 */
export function renderTex(tex, target, display) {
  if (!katex) return false;
  const tmp = document.createElement(display ? 'div' : 'span');
  try {
    katex.render(repairTex(tex), tmp, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false, maxSize: 50, maxExpand: 500 });
  } catch {
    return false;
  }
  target.replaceChildren(...tmp.childNodes);
  return true;
}
