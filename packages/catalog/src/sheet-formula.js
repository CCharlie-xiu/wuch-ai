// ─────────────────────────────────────────────────────────────────────────────
// Sheet 的公式引擎：Excel 写法的一个小子集，在页面上实时算。
//
//   单元格 { v, f? }：f 是去掉 = 的公式，v 是值（导入 xlsx 时带的缓存值，算不出时兜底）
//   引用 A1 / $A$1，区域 A1:B3；运算 + - * / ^ & % 与比较；函数见 FUNCS
//   错误值是 { err: '#REF!' } 这样的对象，不会和用户写的字符串混淆
//
// 只做字符扫描 + 递归下降 + 查表求值，没有 eval。
// ─────────────────────────────────────────────────────────────────────────────

export const err = (code) => ({ err: code });
export const isErr = (v) => v != null && typeof v === 'object' && typeof v.err === 'string';

/** 'AB' → 27（从 0 数） */
export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colLetters(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 'B3' → { row: 2, col: 1 }；不是引用返回 null */
export function parseRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(String(ref).trim());
  if (!m) return null;
  return { col: colIndex(m[1]), row: Number(m[2]) - 1 };
}

export const refName = (row, col) => `${colLetters(col)}${row + 1}`;

/** 模型 / 用户写的原始值 → 单元格：以 = 开头的字符串是公式 */
export function toCell(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && ('v' in raw || 'f' in raw)) return raw;
  if (typeof raw === 'string' && raw.startsWith('=') && raw.length > 1) return { v: null, f: raw.slice(1) };
  return { v: raw === undefined ? null : raw };
}

/** 单元格 → 编辑框里显示的原文 */
export function cellSource(cell) {
  if (!cell) return '';
  if (cell.f) return '=' + cell.f;
  return cell.v == null ? '' : String(cell.v);
}

/** 编辑框里输入的文字 → 单元格：数字字符串转数字 */
export function parseInput(text) {
  const t = String(text ?? '');
  if (t.startsWith('=') && t.length > 1) return { v: null, f: t.slice(1) };
  if (t.trim() === '') return { v: null };
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t.trim())) return { v: Number(t.trim()) };
  if (/^(true|false)$/i.test(t.trim())) return { v: t.trim().toLowerCase() === 'true' };
  return { v: t };
}

// ── 词法 ────────────────────────────────────────────────────────────────────
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          s += '"';
          j += 2;
        } else if (src[j] === '"') break;
        else s += src[j++];
      }
      if (j >= src.length) throw err('#VALUE!');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^\$?[A-Za-z_][A-Za-z0-9_.]*\$?\d*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      if (parseRef(w)) out.push({ t: 'ref', v: w });
      else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(w)) out.push({ t: 'id', v: w.toUpperCase() });
      else throw err('#NAME?');
      i += w.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^&=<>(),:%'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    throw err('#NAME?');
  }
  return out;
}

// ── 语法：递归下降 ──────────────────────────────────────────────────────────
export function parseFormula(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].t === 'op' && toks[p].v === v;
  const take = () => toks[p++];
  const expect = (v) => {
    if (!isOp(v)) throw err('#VALUE!');
    p++;
  };

  function comparison() {
    let left = concat();
    while (peek() && peek().t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().v)) {
      const op = take().v;
      left = { k: 'bin', op, a: left, b: concat() };
    }
    return left;
  }
  function concat() {
    let left = additive();
    while (isOp('&')) {
      take();
      left = { k: 'bin', op: '&', a: left, b: additive() };
    }
    return left;
  }
  function additive() {
    let left = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = take().v;
      left = { k: 'bin', op, a: left, b: multiplicative() };
    }
    return left;
  }
  function multiplicative() {
    let left = power();
    while (isOp('*') || isOp('/')) {
      const op = take().v;
      left = { k: 'bin', op, a: left, b: power() };
    }
    return left;
  }
  function power() {
    let left = unary();
    while (isOp('^')) {
      take();
      left = { k: 'bin', op: '^', a: left, b: unary() };
    }
    return left;
  }
  function unary() {
    if (isOp('-') || isOp('+')) {
      const op = take().v;
      const a = unary();
      return op === '-' ? { k: 'neg', a } : a;
    }
    return postfix();
  }
  function postfix() {
    let a = primary();
    while (isOp('%')) {
      take();
      a = { k: 'bin', op: '/', a, b: { k: 'num', v: 100 } };
    }
    return a;
  }
  function primary() {
    const tk = take();
    if (!tk) throw err('#VALUE!');
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'str') return { k: 'str', v: tk.v };
    if (tk.t === 'ref') {
      if (isOp(':')) {
        take();
        const end = take();
        if (!end || end.t !== 'ref') throw err('#REF!');
        return { k: 'range', a: parseRef(tk.v), b: parseRef(end.v) };
      }
      return { k: 'ref', r: parseRef(tk.v) };
    }
    if (tk.t === 'id') {
      if (tk.v === 'TRUE' || tk.v === 'FALSE') return { k: 'bool', v: tk.v === 'TRUE' };
      if (!isOp('(')) throw err('#NAME?');
      take();
      const args = [];
      if (!isOp(')')) {
        args.push(comparison());
        while (isOp(',')) {
          take();
          args.push(comparison());
        }
      }
      expect(')');
      return { k: 'call', name: tk.v, args };
    }
    if (tk.t === 'op' && tk.v === '(') {
      const e = comparison();
      expect(')');
      return e;
    }
    throw err('#VALUE!');
  }

  const ast = comparison();
  if (p !== toks.length) throw err('#VALUE!');
  return ast;
}

// ── 求值 ────────────────────────────────────────────────────────────────────
function toNum(v) {
  if (isErr(v)) return v;
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : err('#VALUE!');
}

const toText = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const truthy = (v) => (typeof v === 'string' ? v !== '' && v.toUpperCase() !== 'FALSE' : !!v);

/** 区域展开成值；SUM 一类只取数字 */
const flat = (args) => args.flat(Infinity);
const numbers = (vals) => vals.filter((v) => typeof v === 'number');
function firstErr(vals) {
  return vals.find(isErr);
}

const FUNCS = {
  SUM: (a) => firstErr(flat(a)) || numbers(flat(a)).reduce((s, x) => s + x, 0),
  AVERAGE: (a) => {
    const vals = flat(a);
    const e = firstErr(vals);
    if (e) return e;
    const ns = numbers(vals);
    return ns.length ? ns.reduce((s, x) => s + x, 0) / ns.length : err('#DIV/0!');
  },
  MIN: (a) => firstErr(flat(a)) || (numbers(flat(a)).length ? Math.min(...numbers(flat(a))) : 0),
  MAX: (a) => firstErr(flat(a)) || (numbers(flat(a)).length ? Math.max(...numbers(flat(a))) : 0),
  COUNT: (a) => numbers(flat(a)).length,
  COUNTA: (a) => flat(a).filter((v) => v != null && v !== '').length,
  ROUND: ([x, d = 0]) => {
    const n = toNum(x);
    const k = toNum(d);
    if (isErr(n)) return n;
    if (isErr(k)) return k;
    const f = 10 ** Math.trunc(k);
    return Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
  },
  ABS: ([x]) => {
    const n = toNum(x);
    return isErr(n) ? n : Math.abs(n);
  },
  IF: ([c, a = true, b = false]) => (isErr(c) ? c : truthy(c) ? a : b),
  AND: (a) => firstErr(flat(a)) || flat(a).every(truthy),
  OR: (a) => firstErr(flat(a)) || flat(a).some(truthy),
  NOT: ([x]) => (isErr(x) ? x : !truthy(x)),
  CONCAT: (a) => firstErr(flat(a)) || flat(a).map(toText).join(''),
  LEN: ([x]) => (isErr(x) ? x : toText(x).length),
};
FUNCS.AVG = FUNCS.AVERAGE;
FUNCS.CONCATENATE = FUNCS.CONCAT;
export const FUNCTION_NAMES = Object.keys(FUNCS);

function compare(op, a, b) {
  if (typeof a === 'string' || typeof b === 'string') {
    a = toText(a).toLowerCase();
    b = toText(b).toLowerCase();
  } else {
    a = toNum(a);
    b = toNum(b);
  }
  switch (op) {
    case '=':
      return a === b;
    case '<>':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    default:
      return a >= b;
  }
}

/**
 * 算一整张表。cells 是二维数组（单元格或原始值）。
 * 返回同形状的值矩阵；错误值是 { err }。
 */
export function evaluateSheet(cells) {
  const grid = (cells || []).map((row) => (Array.isArray(row) ? row.map(toCell) : []));
  const memo = new Map();
  const visiting = new Set();
  const asts = new Map();

  function cellValue(row, col) {
    if (row < 0 || col < 0) return err('#REF!');
    const cell = grid[row] && grid[row][col];
    if (!cell) return null;
    if (!cell.f) return cell.v ?? null;
    const key = row * 100000 + col;
    if (memo.has(key)) return memo.get(key);
    if (visiting.has(key)) return err('#CYCLE!');
    visiting.add(key);
    let out;
    try {
      let ast = asts.get(key);
      if (!ast) {
        ast = parseFormula(cell.f);
        asts.set(key, ast);
      }
      out = evalNode(ast);
      if (Array.isArray(out)) out = out.flat(Infinity)[0] ?? null;
    } catch (e) {
      out = isErr(e) ? e : err('#VALUE!');
    }
    visiting.delete(key);
    if (typeof out === 'number' && !Number.isFinite(out)) out = err('#NUM!');
    memo.set(key, out);
    return out;
  }

  function evalNode(n) {
    switch (n.k) {
      case 'num':
      case 'str':
      case 'bool':
        return n.v;
      case 'ref':
        return cellValue(n.r.row, n.r.col);
      case 'range': {
        const r0 = Math.min(n.a.row, n.b.row);
        const r1 = Math.max(n.a.row, n.b.row);
        const c0 = Math.min(n.a.col, n.b.col);
        const c1 = Math.max(n.a.col, n.b.col);
        if ((r1 - r0 + 1) * (c1 - c0 + 1) > 200000) return err('#REF!');
        const out = [];
        for (let r = r0; r <= r1; r++) {
          const row = [];
          for (let c = c0; c <= c1; c++) row.push(cellValue(r, c));
          out.push(row);
        }
        return out;
      }
      case 'neg': {
        const v = toNum(scalar(evalNode(n.a)));
        return isErr(v) ? v : -v;
      }
      case 'bin': {
        const a = scalar(evalNode(n.a));
        const b = scalar(evalNode(n.b));
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        if (n.op === '&') return toText(a) + toText(b);
        if (['=', '<>', '<', '>', '<=', '>='].includes(n.op)) return compare(n.op, a, b);
        const x = toNum(a);
        const y = toNum(b);
        if (isErr(x)) return x;
        if (isErr(y)) return y;
        if (n.op === '+') return x + y;
        if (n.op === '-') return x - y;
        if (n.op === '*') return x * y;
        if (n.op === '/') return y === 0 ? err('#DIV/0!') : x / y;
        return x ** y;
      }
      case 'call': {
        const fn = FUNCS[n.name];
        if (!fn) return err('#NAME?');
        // IF 只算被选中的分支，未选分支里的循环 / 错误不影响结果
        if (n.name === 'IF') {
          const c = scalar(evalNode(n.args[0] || { k: 'bool', v: false }));
          if (isErr(c)) return c;
          const pick = truthy(c) ? n.args[1] : n.args[2];
          return pick ? scalar(evalNode(pick)) : truthy(c);
        }
        return fn(n.args.map(evalNode));
      }
      default:
        return err('#VALUE!');
    }
  }

  const scalar = (v) => (Array.isArray(v) ? (v.flat(Infinity)[0] ?? null) : v);

  return grid.map((row, r) => row.map((_, c) => cellValue(r, c)));
}

/** 值 → 单元格里显示的文字 */
export function formatValue(v) {
  if (isErr(v)) return v.err;
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    return Number(v.toPrecision(12)).toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
  return String(v);
}
