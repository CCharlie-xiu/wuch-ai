// ─────────────────────────────────────────────────────────────────────────────
// 解析器：词法（lexer）+ 语法（parser）
//
// 输入是一份**受限**的声明式文本，不是 JavaScript：
//
//   name = Component(arg, arg, ...)     组件调用
//   name = [a, b, [c]]                  数组（可嵌套）
//   name = "str" | 123 | true | false | null
//   name = otherName                    变量引用
//
// 刻意不支持：任意表达式、函数/循环/条件、import、运算符、模板串、对象字面量。
// 支持的越少，能表达的危险就越少 —— 这是这个 DSL 存在的理由之一。
//
// 实现约束两条：
//   1. 逐字符扫描，**不用正则去切整份源码**。括号/数组/字符串的嵌套必须由
//      带状态的扫描器处理，正则切不开。
//   2. 每个错误都带 偏移 + 行 + 列。DSL 由模型流式产出，位置是唯一可定位的东西。
//
// 关于「空白自由」：语句之间没有分隔符 token，靠值自身可终结（调用/数组/字面量/
// 变量名都自然结束）。所以换行、缩进、一行多条语句都能解析。
// ─────────────────────────────────────────────────────────────────────────────

import type { Definition, Expr } from './ast.ts';
import { CODES, DslError, type Pos } from './diagnostics.ts';

// ── 词法 ────────────────────────────────────────────────────────────────────
type TokenKind = 'ident' | 'string' | 'number' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  /** punct 是符号本身；ident/string 是文本；number 是原文 */
  value: string;
  /** number 的数值 */
  num?: number;
  pos: Pos;
}

const PUNCT = new Set(['(', ')', '[', ']', ',', '=']);
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
/** 数字：整数、小数、指数。不用它切整份源码，只在扫描到数字起点时匹配一个 token */
const NUMBER_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/;

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isSpace = (ch: string): boolean =>
  ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v';

function describe(t: Token): string {
  switch (t.kind) {
    case 'eof':
      return '文本结束';
    case 'string':
      return `字符串 ${JSON.stringify(t.value)}`;
    case 'number':
      return `数字 ${t.value}`;
    case 'punct':
      return `符号 ${JSON.stringify(t.value)}`;
    default:
      return `标识符 ${JSON.stringify(t.value)}`;
  }
}

class Lexer {
  private i = 0;
  private line = 1;
  private col = 1;
  private readonly out: Token[] = [];
  /** 宽容模式下记下的词法错误（严格模式直接抛出） */
  readonly errors: DslError[] = [];

  constructor(
    private readonly src: string,
    private readonly tolerant = false,
  ) {}

  private pos(): Pos {
    return { offset: this.i, line: this.line, column: this.col };
  }

  private advance(count = 1): void {
    for (let n = 0; n < count; n++) {
      const ch = this.src[this.i];
      this.i += 1;
      if (ch === '\n') {
        this.line += 1;
        this.col = 1;
      } else {
        this.col += 1;
      }
    }
  }

  private skipSpace(): void {
    while (this.i < this.src.length && isSpace(this.src[this.i]!)) this.advance();
  }

  run(): Token[] {
    if (!this.tolerant) return this.scan();
    for (;;) {
      try {
        return this.scan();
      } catch (e) {
        if (!(e instanceof DslError)) throw e;
        this.errors.push(e);
        if (e.code === CODES.UNTERMINATED_STRING) {
          // 字符串一直开到文本结束：这是流式里「切在字符串中间」，后面没东西了
          this.out.push({ kind: 'eof', value: '', pos: e.pos ?? this.pos() });
          return this.out;
        }
        this.advance(); // 认不出的字符：跳过它继续
      }
    }
  }

  private scan(): Token[] {
    for (;;) {
      this.skipSpace();
      if (this.i >= this.src.length) {
        this.out.push({ kind: 'eof', value: '', pos: this.pos() });
        return this.out;
      }

      const ch = this.src[this.i]!;

      if (ch === '"' || ch === "'") {
        this.readString(ch);
        continue;
      }
      const next = this.src[this.i + 1] ?? '';
      if (isDigit(ch) || ((ch === '.' || ch === '-') && isDigit(next))) {
        this.readNumber();
        continue;
      }
      if (IDENT_START.test(ch)) {
        this.readIdent();
        continue;
      }
      if (PUNCT.has(ch)) {
        const pos = this.pos();
        this.advance();
        this.out.push({ kind: 'punct', value: ch, pos });
        continue;
      }

      throw new DslError(
        CODES.UNEXPECTED_CHAR,
        `无法识别的字符 ${JSON.stringify(ch)}（DSL 只接受标识符、字符串、数字、括号、逗号、等号）`,
        this.pos(),
      );
    }
  }

  private readIdent(): void {
    const pos = this.pos();
    let text = '';
    while (this.i < this.src.length && IDENT_PART.test(this.src[this.i]!)) {
      text += this.src[this.i]!;
      this.advance();
    }
    this.out.push({ kind: 'ident', value: text, pos });
  }

  private readNumber(): void {
    const pos = this.pos();
    const rest = this.src.slice(this.i);
    const m = NUMBER_RE.exec(rest.startsWith('-') ? rest.slice(1) : rest);
    if (!m) {
      throw new DslError(CODES.UNEXPECTED_TOKEN, '数字格式不合法', pos);
    }
    const negative = rest.startsWith('-');
    const raw = (negative ? '-' : '') + m[0];
    this.advance(raw.length);
    this.out.push({ kind: 'number', value: raw, num: Number(raw), pos });
  }

  private readString(quote: string): void {
    const pos = this.pos();
    this.advance(); // 开引号
    let text = '';
    for (;;) {
      if (this.i >= this.src.length) {
        throw new DslError(CODES.UNTERMINATED_STRING, `字符串没有闭合的 ${quote}`, pos);
      }
      const ch = this.src[this.i]!;
      if (ch === quote) {
        this.advance();
        break;
      }
      if (ch === '\\') {
        this.advance();
        if (this.i >= this.src.length) {
          throw new DslError(CODES.UNTERMINATED_STRING, `字符串没有闭合的 ${quote}`, pos);
        }
        const esc = this.src[this.i]!;
        this.advance();
        switch (esc) {
          case 'n': text += '\n'; break;
          case 't': text += '\t'; break;
          case 'r': text += '\r'; break;
          case 'b': text += '\b'; break;
          case 'f': text += '\f'; break;
          case 'v': text += '\v'; break;
          case '0': text += '\0'; break;
          case 'u': {
            const hex = this.src.slice(this.i, this.i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              if (this.tolerant && this.i + 4 <= this.src.length) {
                text += 'u';
                break;
              }
              throw new DslError(
                CODES.UNEXPECTED_CHAR,
                `\\u 转义需要 4 位十六进制，实际读到 ${JSON.stringify(hex)}`,
                this.pos(),
              );
            }
            text += String.fromCharCode(parseInt(hex, 16));
            this.advance(4);
            break;
          }
          default:
            // 未知转义保留原字符：\" \' \\ \/ 以及任何其他字符都当作字面量
            text += esc;
        }
        continue;
      }
      text += ch;
      this.advance();
    }
    this.out.push({ kind: 'string', value: text, pos });
  }
}

// ── 语法 ────────────────────────────────────────────────────────────────────
class Parser {
  private i = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly maxDepth: number,
  ) {}

  private peek(offset = 0): Token {
    const idx = Math.min(this.i + offset, this.tokens.length - 1);
    return this.tokens[idx]!;
  }

  private take(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.i += 1;
    return t;
  }

  private expectPunct(value: string, hint: string): Token {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === value) return this.take();
    throw new DslError(
      CODES.EXPECTED_TOKEN,
      `${hint}：期待 ${JSON.stringify(value)}，实际读到 ${describe(t)}`,
      t.pos,
    );
  }

  parseProgram(): Definition[] {
    const definitions: Definition[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  /**
   * 宽容版：一条语句坏了不连累其他语句。
   *   · 在文本结束处坏掉 = 流式里还没写完的最后一条，记为 incomplete，丢掉
   *   · 在中间坏掉 = 真错误，记下来，跳到下一条「变量名 =」继续
   */
  parseProgramTolerant(): TolerantProgram {
    const definitions: Definition[] = [];
    const errors: DslError[] = [];
    let incomplete: Pos | null = null;
    while (this.peek().kind !== 'eof') {
      const start = this.peek();
      try {
        definitions.push(this.parseDefinition());
      } catch (e) {
        if (!(e instanceof DslError)) throw e;
        if (this.peek().kind === 'eof') {
          incomplete = start.pos;
          break;
        }
        errors.push(e);
        this.resync(e.pos?.line ?? start.pos.line);
      }
    }
    return { definitions, errors, incomplete };
  }

  /** 跳到出错行之后、下一个形如「标识符 =」的位置 */
  private resync(line: number): void {
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      const next = this.peek(1);
      if (t.pos.line > line && t.kind === 'ident' && next.kind === 'punct' && next.value === '=') return;
      this.take();
    }
  }

  private parseDefinition(): Definition {
    const t = this.peek();
    if (t.kind !== 'ident') {
      throw new DslError(
        CODES.EXPECTED_TOKEN,
        `顶层语句必须形如「变量名 = 值」，这里期待变量名，实际读到 ${describe(t)}`,
        t.pos,
      );
    }
    const nameTok = this.take();
    this.expectPunct('=', `变量 ${JSON.stringify(nameTok.value)} 后面需要 "="`);
    const value = this.parseValue(1);
    return { name: nameTok.value, value, pos: nameTok.pos };
  }

  private guardDepth(depth: number, pos: Pos): void {
    if (depth > this.maxDepth) {
      throw new DslError(
        CODES.DEPTH_EXCEEDED,
        `嵌套深度超过上限 ${this.maxDepth}（防栈溢出；可用 options.maxDepth 放宽）`,
        pos,
      );
    }
  }

  private parseValue(depth: number): Expr {
    const t = this.peek();

    if (t.kind === 'string') {
      this.take();
      return { kind: 'string', value: t.value, pos: t.pos };
    }

    if (t.kind === 'number') {
      this.take();
      return { kind: 'number', value: t.num!, pos: t.pos };
    }

    if (t.kind === 'punct' && t.value === '[') {
      this.guardDepth(depth, t.pos);
      this.take();
      return { kind: 'array', items: this.parseArrayItems(depth), pos: t.pos };
    }

    if (t.kind === 'ident') {
      // 三个字面量关键字：true / false / null
      if (t.value === 'true' || t.value === 'false') {
        this.take();
        return { kind: 'boolean', value: t.value === 'true', pos: t.pos };
      }
      if (t.value === 'null') {
        this.take();
        return { kind: 'null', pos: t.pos };
      }

      this.take();
      const after = this.peek();
      if (after.kind === 'punct' && after.value === '(') {
        this.guardDepth(depth, t.pos);
        this.take();
        return { kind: 'call', component: t.value, args: this.parseArgs(depth), pos: t.pos };
      }
      return { kind: 'ref', name: t.value, pos: t.pos };
    }

    throw new DslError(
      CODES.UNEXPECTED_TOKEN,
      `这里需要一个值（字符串 / 数字 / true / false / null / 数组 / 变量名 / 组件调用），实际读到 ${describe(t)}`,
      t.pos,
    );
  }

  /** 已消费 "("；读取到匹配的 ")" 为止 */
  private parseArgs(depth: number): Expr[] {
    const args: Expr[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === ')') {
      this.take();
      return args;
    }
    for (;;) {
      args.push(this.parseValue(depth + 1));
      const t = this.take();
      if (t.kind === 'punct' && t.value === ')') return args;
      if (t.kind === 'punct' && t.value === ',') {
        // 允许尾逗号
        if (this.peek().kind === 'punct' && this.peek().value === ')') {
          this.take();
          return args;
        }
        continue;
      }
      throw new DslError(
        CODES.EXPECTED_TOKEN,
        `组件参数之间需要 "," 或收尾的 ")"，实际读到 ${describe(t)}`,
        t.pos,
      );
    }
  }

  /** 已消费 "["；读取到匹配的 "]" 为止 */
  private parseArrayItems(depth: number): Expr[] {
    const items: Expr[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === ']') {
      this.take();
      return items;
    }
    for (;;) {
      items.push(this.parseValue(depth + 1));
      const t = this.take();
      if (t.kind === 'punct' && t.value === ']') return items;
      if (t.kind === 'punct' && t.value === ',') {
        if (this.peek().kind === 'punct' && this.peek().value === ']') {
          this.take();
          return items;
        }
        continue;
      }
      throw new DslError(
        CODES.EXPECTED_TOKEN,
        `数组元素之间需要 "," 或收尾的 "]"，实际读到 ${describe(t)}`,
        t.pos,
      );
    }
  }
}

// ── 对外的两个阶段 ──────────────────────────────────────────────────────────
export function tokenize(src: string): Token[] {
  return new Lexer(src).run();
}

export function parseProgram(src: string, maxDepth: number): Definition[] {
  const tokens = tokenize(src);
  return new Parser(tokens, maxDepth).parseProgram();
}

export interface TolerantProgram {
  definitions: Definition[];
  /** 词法 + 语法错误（不含末尾未写完的那条） */
  errors: DslError[];
  /** 末尾那条没写完的语句从哪开始；全部完整时为 null */
  incomplete: Pos | null;
}

/** 宽容解析：永不抛 DslError，坏掉的语句被跳过并记录 */
export function parseProgramTolerant(src: string, maxDepth: number): TolerantProgram {
  const lexer = new Lexer(src, true);
  const tokens = lexer.run();
  const out = new Parser(tokens, maxDepth).parseProgramTolerant();
  // 词法层的未闭合字符串 = 末尾语句没写完，已经体现在 incomplete 里
  const lexErrors = lexer.errors.filter((e) => e.code !== CODES.UNTERMINATED_STRING);
  if (out.incomplete === null && lexer.errors.some((e) => e.code === CODES.UNTERMINATED_STRING)) {
    out.incomplete = lexer.errors.find((e) => e.code === CODES.UNTERMINATED_STRING)!.pos ?? null;
  }
  return { ...out, errors: [...lexErrors, ...out.errors] };
}
