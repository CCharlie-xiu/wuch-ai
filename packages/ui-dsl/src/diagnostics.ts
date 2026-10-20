// ─────────────────────────────────────────────────────────────────────────────
// 诊断：统一错误/警告的形状与错误码
//
// 这一层存在的唯一理由是「失败必须是结构化的」：调用方要能按错误码分支处理，
// 而不是去解析一句人类可读的字符串。位置（偏移 + 行列）永远带上 ——
// DSL 是给人的手写体，也常由模型流式产出，没有位置就无法定位。
//
// 没有位置信息的诊断（例如 E_MISSING_ROOT）允许省略 pos。
// ─────────────────────────────────────────────────────────────────────────────

export interface Pos {
  /** 0 起的字符偏移 */
  offset: number;
  /** 1 起的行号 */
  line: number;
  /** 1 起的列号 */
  column: number;
}

export type Severity = 'error' | 'warning';

export const CODES = {
  // ── 边界（源码级）───────────────────────────────────────────────────────
  SOURCE_TOO_LONG: 'E_SOURCE_TOO_LONG',
  EMPTY_SOURCE: 'E_EMPTY_SOURCE',
  DEPTH_EXCEEDED: 'E_DEPTH_EXCEEDED',
  NODE_BUDGET_EXCEEDED: 'E_NODE_BUDGET_EXCEEDED',

  // ── 词法 / 语法 ─────────────────────────────────────────────────────────
  UNEXPECTED_CHAR: 'E_UNEXPECTED_CHAR',
  UNEXPECTED_TOKEN: 'E_UNEXPECTED_TOKEN',
  UNTERMINATED_STRING: 'E_UNTERMINATED_STRING',
  EXPECTED_TOKEN: 'E_EXPECTED_TOKEN',
  /** 最后一条语句没写完（流式中是常态，记为恢复诊断；流结束时仍如此才算错误） */
  INCOMPLETE_STATEMENT: 'E_INCOMPLETE_STATEMENT',

  // ── 阶段一：定义收集 ────────────────────────────────────────────────────
  DUPLICATE_DEFINITION: 'E_DUPLICATE_DEFINITION',
  /** 宽容模式：同名变量再次定义，后者覆盖前者 */
  REDEFINED: 'W_REDEFINED',

  // ── 阶段二：引用解析 ────────────────────────────────────────────────────
  UNDEFINED_REFERENCE: 'E_UNDEFINED_REFERENCE',
  CYCLIC_REFERENCE: 'E_CYCLIC_REFERENCE',
  MISSING_ROOT: 'E_MISSING_ROOT',

  // ── 校验 ────────────────────────────────────────────────────────────────
  UNKNOWN_COMPONENT: 'E_UNKNOWN_COMPONENT',
  /** 宽容模式：组件因为必填参数缺失 / 为 null 被整个摘掉 */
  DROPPED_COMPONENT: 'E_DROPPED_COMPONENT',
  ARG_COUNT: 'E_ARG_COUNT',
  MISSING_REQUIRED_ARG: 'E_MISSING_REQUIRED_ARG',
  ARG_TYPE: 'E_ARG_TYPE',
  ROOT_NOT_COMPONENT: 'E_ROOT_NOT_COMPONENT',

  // ── 警告 ────────────────────────────────────────────────────────────────
  UNUSED_DEFINITION: 'W_UNUSED_DEFINITION',
  SKIPPED_OPTIONAL: 'W_SKIPPED_OPTIONAL',
} as const;

export type DiagnosticCode = (typeof CODES)[keyof typeof CODES];

export interface Diagnostic {
  severity: Severity;
  code: DiagnosticCode;
  message: string;
  /** 源码位置；只有全局性问题（如缺少 root）才缺省 */
  pos?: Pos;
}

/** 内部用：解析阶段的致命错误。绝不外泄 —— index.ts 一律转成 Diagnostic 返回。 */
export class DslError extends Error {
  constructor(
    readonly code: DiagnosticCode,
    message: string,
    readonly pos?: Pos,
  ) {
    super(message);
    this.name = 'DslError';
  }
}

export const error = (code: DiagnosticCode, message: string, pos?: Pos): Diagnostic =>
  pos ? { severity: 'error', code, message, pos } : { severity: 'error', code, message };

export const warning = (code: DiagnosticCode, message: string, pos?: Pos): Diagnostic =>
  pos ? { severity: 'warning', code, message, pos } : { severity: 'warning', code, message };

export const isError = (d: Diagnostic): boolean => d.severity === 'error';

/** 一行一条，形如 `3:9  error[E_UNKNOWN_COMPONENT]  未知组件 "Foo"` */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const where = d.pos ? `${d.pos.line}:${d.pos.column}` : '—';
      return `${where.padEnd(9)}${d.severity.padEnd(7)}[${d.code}]  ${d.message}`;
    })
    .join('\n');
}
