// ─────────────────────────────────────────────────────────────────────────────
// 语句级合并：续画（@edit）时模型只写改动的语句，按变量名合进上一版原文。
//
//   同名变量   整条覆盖，位置不变
//   新变量     追加（放在 summary 前面，summary 永远最后）
//   x = null   删掉 x
//
// 切语句靠逐字符扫描：在括号深度 0、字符串之外，「标识符 + 空白 + =」就是一条新语句的开头
// （= 在值里不可能出现）。和解析器一样，不用正则切整份源码。
// ─────────────────────────────────────────────────────────────────────────────

export interface Statement {
  name: string;
  /** 整条语句原文（含变量名和 =），去掉首尾空白 */
  text: string;
  /** 右边的值原文 */
  value: string;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** 切成语句；第一条语句之前的内容（比如半截变量名）丢掉 */
export function splitStatements(src: string): Statement[] {
  const starts: { at: number; name: string; valueAt: number }[] = [];
  let depth = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === '"') {
      i++;
      while (i < n && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '(' || ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (IDENT_START.test(ch) && (i === 0 || !IDENT_PART.test(src[i - 1]!))) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j]!)) j++;
      const name = src.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(src[k]!)) k++;
      if (depth === 0 && src[k] === '=') {
        starts.push({ at: i, name, valueAt: k + 1 });
        i = k + 1;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  return starts.map((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1]!.at : n;
    return { name: s.name, text: src.slice(s.at, end).trim(), value: src.slice(s.valueAt, end).trim() };
  });
}

export interface MergeOptions {
  /**
   * 流式中最后一条补丁语句可能还没写完：把它放到最后，免得半截的括号吞掉后面的语句。
   * 流结束（final）时才放回原位。
   */
  final?: boolean;
}

export function mergeSource(base: string, patch: string, { final = false }: MergeOptions = {}): string {
  const out = splitStatements(base);
  const index = new Map(out.map((s, i) => [s.name, i]));
  const removed = new Set<string>();
  const patches = splitStatements(patch);
  const tail: Statement[] = [];
  patches.forEach((s, i) => {
    const pending = !final && i === patches.length - 1;
    if (s.value === 'null') {
      removed.add(s.name);
      return;
    }
    removed.delete(s.name);
    if (pending) {
      removed.add(s.name);
      tail.push(s);
      return;
    }
    const at = index.get(s.name);
    if (at != null) {
      out[at] = s;
      return;
    }
    // 新变量排在 summary 前面
    const summaryAt = index.get('summary');
    if (summaryAt != null && s.name !== 'summary') {
      out.splice(summaryAt, 0, s);
      for (const [k, v] of index) if (v >= summaryAt) index.set(k, v + 1);
      index.set(s.name, summaryAt);
    } else {
      index.set(s.name, out.length);
      out.push(s);
    }
  });
  const kept = out.filter((s) => !removed.has(s.name));
  return [...kept, ...tail].map((s) => s.text).join('\n');
}

/** 模型回答的第一行模式指令：@edit / @new；没写返回 null */
export function readModeLine(text: string): { mode: 'edit' | 'new' | null; rest: string } {
  const m = /^\s*@(edit|new)\b[^\n]*(?:\n|$)/i.exec(text);
  if (!m) return { mode: null, rest: text };
  return { mode: m[1]!.toLowerCase() as 'edit' | 'new', rest: text.slice(m[0].length) };
}
