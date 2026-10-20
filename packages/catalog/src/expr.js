// ─────────────────────────────────────────────────────────────────────────────
// 数学表达式求值：白名单 tokenizer + 递归下降。
//
// 为什么不用 eval / new Function：表达式是模型写的字符串，而组件跑在宿主页面上
// （不在沙箱里，lockdown 保护不到这里）。动态求值等于把任意代码执行权交出去。
//
// 认得的东西只有：数字、变量 x、常量 pi / e / tau、+ - * / ^、括号，
// 以及下面这张固定的函数表。不认识的一律抛错，不做任何猜测或回退。
// ─────────────────────────────────────────────────────────────────────────────

export const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  exp: Math.exp, ln: Math.log, log: Math.log10, lg: Math.log10, log2: Math.log2,
  sqrt: Math.sqrt, abs: Math.abs, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max,
};

export const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

export function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      const text = src.slice(i, j);
      const n = Number(text);
      if (!Number.isFinite(n)) throw new Error(`数字写错了：${text}`);
      out.push({ t: 'num', v: n });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`看不懂的字符「${c}」`);
  }
  if (!out.length) throw new Error('表达式是空的');
  return out;
}

/** 递归下降 → 闭包。返回 (x) => y，全程没有动态求值 */
export function parseTokens(tk) {
  let p = 0;
  const peek = () => tk[p];
  const eat = (t) => (peek() && peek().t === t ? (p++, true) : false);

  function expr() {
    let left = term();
    for (;;) {
      if (eat('+')) { const r = term(), l = left; left = (x) => l(x) + r(x); }
      else if (eat('-')) { const r = term(), l = left; left = (x) => l(x) - r(x); }
      else return left;
    }
  }
  function term() {
    let left = unary();
    for (;;) {
      if (eat('*')) { const r = unary(), l = left; left = (x) => l(x) * r(x); }
      else if (eat('/')) { const r = unary(), l = left; left = (x) => l(x) / r(x); }
      else return left;
    }
  }
  function unary() {
    if (eat('-')) { const v = unary(); return (x) => -v(x); }
    if (eat('+')) return unary();
    return power();
  }
  function power() {
    const base = atom();
    if (eat('^')) { const ex = unary(); return (x) => Math.pow(base(x), ex(x)); }
    return base;
  }
  function atom() {
    const t = peek();
    if (!t) throw new Error('表达式没写完');
    if (t.t === 'num') { p++; const v = t.v; return () => v; }
    if (t.t === 'name') {
      p++;
      if (eat('(')) {
        const args = [];
        if (!eat(')')) {
          args.push(expr());
          while (eat(',')) args.push(expr());
          if (!eat(')')) throw new Error('括号没闭合');
        }
        const fn = FUNCS[t.v];
        if (!fn) throw new Error(`不认识函数「${t.v}」`);
        return (x) => fn(...args.map((a) => a(x)));
      }
      if (t.v === 'x') return (x) => x;
      if (Object.hasOwn(CONSTS, t.v)) { const v = CONSTS[t.v]; return () => v; }
      throw new Error(`不认识的名字「${t.v}」，变量只有 x`);
    }
    if (eat('(')) {
      const v = expr();
      if (!eat(')')) throw new Error('括号没闭合');
      return v;
    }
    throw new Error(`表达式里多了「${t.t}」`);
  }

  const fn = expr();
  if (p < tk.length) throw new Error('表达式后面还有多余的内容');
  return fn;
}

const CACHE = new Map();

/** @returns {{ok: true, fn: (x: number) => number} | {ok: false, message: string}} */
export function compileExpr(src) {
  const key = String(src ?? '').trim();
  const hit = CACHE.get(key);
  if (hit) return hit;
  let out;
  try {
    out = { ok: true, fn: parseTokens(tokenize(key)) };
  } catch (e) {
    out = { ok: false, message: e.message };
  }
  CACHE.set(key, out);
  return out;
}

/** 求值一次；表达式有问题就抛错。给测试与调用方图方便用 */
export function evaluate(src, x) {
  const r = compileExpr(src);
  if (!r.ok) throw new Error(r.message);
  return r.fn(x);
}
