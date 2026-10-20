// ─────────────────────────────────────────────────────────────────────────────
// 公开 API：两个入口，同一套词法 / 绑定 / 注册表
//
//   parseUiDsl    严格：任何错误都返回失败结果。用于校验一份完整的界面。
//   analyzeUiDsl  宽容：永远产出一棵能渲染的树，坏掉的部分摘掉并记诊断。
//                 用于流式 —— 模型每写一点就重分析一次（见 stream.ts）。
//
// 严格入口的成功与失败用 `ok` 判别，TypeScript 能直接窄化：
//
//   const r = parseUiDsl(src);
//   if (r.ok) r.ast.root.component      // ✓
//   else r.errors.map(d => d.code)      // ✓
//
// 「不执行输入」是硬约束：全流程只有字符扫描 + 建树 + 查表，
// 没有 eval / new Function / vm / 正则替换生成代码。
// ─────────────────────────────────────────────────────────────────────────────

import type { PositionMap, Resolved, UiAst, UiNode } from './ast.ts';
import { CODES, DslError, error, isError, type Diagnostic, type Pos } from './diagnostics.ts';
import { normalize } from './normalize.ts';
import { parseProgram } from './parser.ts';
import { NodeBudgetError, collectDefinitions, resolveReferences } from './resolve.ts';
import { validateTree } from './validate.ts';

export * from './ast.ts';
export { analyzeUiDsl, type AnalyzeOptions, type AnalyzeResult } from './stream.ts';
export { mergeSource, readModeLine, splitStatements, type MergeOptions, type Statement } from './merge.ts';
export { accepts, bindArguments, describeArg, describeParam, type BindResult } from './bind.ts';
export {
  CODES,
  formatDiagnostics,
  isError,
  type Diagnostic,
  type DiagnosticCode,
  type Pos,
  type Severity,
} from './diagnostics.ts';
export {
  ENUMS,
  MAX_WIDTHS,
  REGISTERED_COMPONENTS,
  REGISTRY,
  SPACE_TOKENS,
  TEXT_STYLES,
  lookupComponent,
  type ComponentSpec,
  type ParamSpec,
  type ParamType,
} from './registry.ts';

export interface ParseOptions {
  /** 表达式嵌套深度上限，默认 64 */
  maxDepth?: number;
  /** 源码长度上限（字符），默认 512 KiB */
  maxSourceLength?: number;
  /** 解析出的组件节点总数上限（防同一变量被多处引用导致内联膨胀），默认 5000 */
  maxNodes?: number;
  /**
   * 是否为「被跳过的可选参数」产出 W_SKIPPED_OPTIONAL 警告，默认 false。
   *
   * 默认关闭是刻意的：`Input("name","ph","text",["required"])` 这种写法是
   * **正常用法**，每次都给警告会变成噪音。打开它用于审计「实参到底绑到了哪个参数」。
   */
  reportSkippedArguments?: boolean;
}

export interface ParseSuccess {
  ok: true;
  ast: UiAst;
  /** 成功时只会有 warning */
  diagnostics: Diagnostic[];
  warnings: Diagnostic[];
}

export interface ParseFailure {
  ok: false;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** errors + warnings，按产生顺序，便于直接展示给用户 */
  diagnostics: Diagnostic[];
}

export type ParseResult = ParseSuccess | ParseFailure;

const DEFAULTS = {
  maxDepth: 64,
  maxSourceLength: 512 * 1024,
  maxNodes: 5000,
} as const;

const EMPTY_POSITIONS: PositionMap = { definitions: {}, references: {} };

function failure(
  errors: Diagnostic[],
  warnings: Diagnostic[] = [],
): ParseFailure {
  return { ok: false, errors, warnings, diagnostics: [...errors, ...warnings] };
}

// ── 入口 ────────────────────────────────────────────────────────────────────
export function parseUiDsl(source: string, options: ParseOptions = {}): ParseResult {
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const maxSourceLength = options.maxSourceLength ?? DEFAULTS.maxSourceLength;
  const maxNodes = options.maxNodes ?? DEFAULTS.maxNodes;

  // ── 边界 1：源码过长 ───────────────────────────────────────────────────
  if (source.length > maxSourceLength) {
    return failure([
      error(
        CODES.SOURCE_TOO_LONG,
        `源码 ${source.length} 字符，超过上限 ${maxSourceLength}（可用 options.maxSourceLength 放宽）`,
      ),
    ]);
  }

  // ── 边界 2：空输入 ─────────────────────────────────────────────────────
  if (source.trim() === '') {
    return failure([
      error(
        CODES.EMPTY_SOURCE,
        '源码为空：DSL 至少需要一个 root 定义（例如 root = Stack([...])）',
        { offset: 0, line: 1, column: 1 },
      ),
    ]);
  }

  // ── 词法 + 语法 ────────────────────────────────────────────────────────
  let definitions;
  try {
    definitions = parseProgram(source, maxDepth);
  } catch (e) {
    if (e instanceof DslError) {
      return failure([error(e.code, e.message, e.pos)]);
    }
    throw e;
  }

  // ── 阶段一：定义收集（重复定义在这里报）────────────────────────────────
  const collected = collectDefinitions({ definitions });
  const diagnostics: Diagnostic[] = [...collected.diagnostics];
  const referencePositions: Record<string, Pos> = {};

  // ── 阶段二：引用解析（未定义 / 循环 / 未引用）──────────────────────────
  let resolvedByName: Map<string, Resolved>;
  let reachable: string[];
  try {
    const resolved = resolveReferences(collected.byName, referencePositions, { maxNodes });
    resolvedByName = resolved.resolvedByName;
    reachable = resolved.reachable;
    diagnostics.push(...resolved.diagnostics);
  } catch (e) {
    if (e instanceof NodeBudgetError) {
      return failure([...diagnostics.filter(isError), error(CODES.NODE_BUDGET_EXCEEDED, e.message, e.pos)]);
    }
    throw e;
  }

  const positions: PositionMap = {
    definitions: collected.positions.definitions,
    references: referencePositions,
  };

  // ── root 存在性 ────────────────────────────────────────────────────────
  const rootResolved = resolvedByName.get('root');
  if (!rootResolved) {
    diagnostics.push(
      error(
        CODES.MISSING_ROOT,
        '缺少 root 定义：DSL 必须有一个名为 root 的变量作为组件树的入口',
        collected.positions.definitions['root'],
      ),
    );
  }

  // ── 校验（只在校验 root 存在时才跑；否则错误会重复且嘈杂）──────────────
  if (rootResolved) {
    diagnostics.push(
      ...validateTree(rootResolved, { reportSkipped: options.reportSkippedArguments === true }),
    );
  }

  const errors = diagnostics.filter(isError);
  const warnings = diagnostics.filter((d) => !isError(d));

  if (errors.length > 0 || !rootResolved) {
    return failure(errors, warnings);
  }

  // ── 规范化：只把 root 可达的组件节点放进最终 AST ────────────────────────
  const nodes: Record<string, UiNode> = {};
  for (const name of reachable) {
    const r = resolvedByName.get(name);
    if (r && r.kind === 'node') nodes[name] = normalize(r) as UiNode;
  }

  const ast: UiAst = {
    root: normalize(rootResolved) as UiNode,
    reachable,
    nodes,
    positions,
  };

  return { ok: true, ast, diagnostics: warnings, warnings };
}
