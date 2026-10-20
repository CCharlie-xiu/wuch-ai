// ─────────────────────────────────────────────────────────────────────────────
// 引用解析：严格两阶段
//
//   阶段一  collectDefinitions —— 只收集顶层定义，**不要求引用目标已存在**
//   阶段二  resolveReferences  —— 解析所有引用、查未定义、查循环、算可达性
//
// 两阶段的必要性由示例本身给出：
//
//   root = Stack([title, form], ...)      ← 引用 title / form
//   title = TextContent("Contact Us", ...) ← 后定义
//
// 单趟解析在阶段一就会因为「title 还没定义」失败。所以顺序必须与语义无关：
// 先收全量符号，再统一连边。
//
// 另一个刻意的选择：**解析全部定义**（不只是 root 可达的）。
// 死代码里的循环引用和未定义引用同样是作者的错误，早报比晚报好。
// 而「进入最终 UI AST」只放 root 可达的节点 —— 两件事分开管。
// ─────────────────────────────────────────────────────────────────────────────

import type { Definition, Expr, PositionMap, RawProgram, Resolved } from './ast.ts';
import { CODES, error, type Diagnostic, type Pos, warning } from './diagnostics.ts';

export interface ResolveLimits {
  /** 解析出的组件节点总数上限，防 DAG 膨胀（同一变量被多处引用会内联多份） */
  maxNodes: number;
}

export interface ResolveResult {
  /** 变量名 → 首个定义（重复定义时保留第一个，后续的报错丢弃） */
  byName: Map<string, Definition>;
  /** 变量名 → 解析结果。仅含**已定义**的名字（未定义引用不会出现在这里） */
  resolvedByName: Map<string, Resolved>;
  /** root 的解析结果；root 未定义或解析失败时为 undefined */
  root?: Resolved;
  /** root 可达的变量名，按首次解析顺序 */
  reachable: string[];
  positions: PositionMap;
  diagnostics: Diagnostic[];
}

// ── 阶段一：定义收集 ────────────────────────────────────────────────────────
export function collectDefinitions(program: RawProgram): {
  byName: Map<string, Definition>;
  positions: PositionMap;
  diagnostics: Diagnostic[];
} {
  const byName = new Map<string, Definition>();
  const definitions: Record<string, Pos> = {};
  const diagnostics: Diagnostic[] = [];

  for (const def of program.definitions) {
    const existing = byName.get(def.name);
    if (existing) {
      // 重复定义立即报错，保留首个，并指出首个定义在哪
      diagnostics.push(
        error(
          CODES.DUPLICATE_DEFINITION,
          `变量 ${JSON.stringify(def.name)} 重复定义（首次定义在第 ${existing.pos.line} 行第 ${existing.pos.column} 列）`,
          def.pos,
        ),
      );
      continue;
    }
    byName.set(def.name, def);
    definitions[def.name] = def.pos;
  }

  return { byName, positions: { definitions, references: {} }, diagnostics };
}

// ── 可达性（在原始语法树上走，与解析结果解耦）──────────────────────────────
export function computeReachable(byName: Map<string, Definition>, rootName: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();

  function walkExpr(e: Expr): void {
    switch (e.kind) {
      case 'ref':
        visit(e.name);
        break;
      case 'call':
        for (const a of e.args) walkExpr(a);
        break;
      case 'array':
        for (const a of e.items) walkExpr(a);
        break;
      default:
        break;
    }
  }

  function visit(name: string): void {
    if (seen.has(name)) return;
    const def = byName.get(name);
    if (!def) return; // 未定义引用：由阶段二报错，这里只负责可达性
    seen.add(name);
    order.push(name);
    walkExpr(def.value);
  }

  visit(rootName);
  return order;
}

// ── 阶段二：引用解析 ────────────────────────────────────────────────────────
export function resolveReferences(
  byName: Map<string, Definition>,
  references: Record<string, Pos>,
  limits: ResolveLimits,
): { resolvedByName: Map<string, Resolved>; reachable: string[]; diagnostics: Diagnostic[] } {
  const resolvedByName = new Map<string, Resolved>();
  const diagnostics: Diagnostic[] = [];
  const stack: string[] = [];
  const onStack = new Set<string>();
  let nodeCount = 0;

  function resolveExpr(e: Expr): Resolved {
    switch (e.kind) {
      case 'string':
      case 'number':
      case 'boolean':
        return { kind: 'literal', value: e.value, pos: e.pos };
      case 'null':
        return { kind: 'literal', value: null, pos: e.pos };
      case 'array':
        return { kind: 'array', items: e.items.map(resolveExpr), pos: e.pos };
      case 'call': {
        nodeCount += 1;
        if (nodeCount > limits.maxNodes) {
          // 不再继续展开：留一条诊断就够，避免把整个进程拖死
          throw new NodeBudgetError(limits.maxNodes, e.pos);
        }
        return {
          kind: 'node',
          name: '',
          component: e.component,
          args: e.args.map(resolveExpr),
          pos: e.pos,
        };
      }
      case 'ref':
        return resolveRef(e.name, e.pos);
    }
  }

  function resolveRef(name: string, pos: Pos): Resolved {
    if (references[name] === undefined) references[name] = pos;

    const cached = resolvedByName.get(name);
    if (cached) return cached;

    if (onStack.has(name)) {
      const at = stack.indexOf(name);
      const path = stack.slice(at).concat(name);
      diagnostics.push(
        error(
          CODES.CYCLIC_REFERENCE,
          `变量引用成环：${path.join(' -> ')}`,
          pos,
        ),
      );
      // 用 null 占位终止递归；错误已经记下，不再往下传
      return { kind: 'literal', value: null, pos };
    }

    const def = byName.get(name);
    if (!def) {
      diagnostics.push(
        error(CODES.UNDEFINED_REFERENCE, `引用了未定义的变量 ${JSON.stringify(name)}`, pos),
      );
      return { kind: 'literal', value: null, pos };
    }

    onStack.add(name);
    stack.push(name);
    const value = resolveExpr(def.value);
    stack.pop();
    onStack.delete(name);

    // 顶层定义的组件节点带上变量名；内联调用保持空串
    const named: Resolved = value.kind === 'node' ? { ...value, name } : value;
    resolvedByName.set(name, named);
    return named;
  }

  // 解析全部定义（含死代码），按源码顺序，错误顺序才可预测
  for (const def of byName.values()) {
    try {
      resolveRef(def.name, def.pos);
    } catch (e) {
      if (e instanceof NodeBudgetError) throw e; // 预算耗尽属致命，交给上层
      throw e;
    }
  }

  const reachable = computeReachable(byName, 'root');

  // 未被 root 引用到的定义：警告，不进最终 AST
  for (const name of byName.keys()) {
    if (!reachable.includes(name)) {
      diagnostics.push(
        warning(
          CODES.UNUSED_DEFINITION,
          `变量 ${JSON.stringify(name)} 未被 root 引用，不会进入组件树`,
          byName.get(name)!.pos,
        ),
      );
    }
  }

  return { resolvedByName, reachable, diagnostics };
}

/** 预算耗尽的内部信号 —— 只有这一条会中断解析（其余都降级成诊断） */
export class NodeBudgetError extends Error {
  constructor(readonly limit: number, readonly pos: Pos) {
    super(`解析出的组件节点超过上限 ${limit}（同一变量被多处引用会内联多份；可用 options.maxNodes 放宽）`);
    this.name = 'NodeBudgetError';
  }
}
