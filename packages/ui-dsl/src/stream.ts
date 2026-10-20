// ─────────────────────────────────────────────────────────────────────────────
// 宽容分析：给流式渲染用的入口
//
// 模型一行一行地写，服务端每隔几百毫秒拿「到目前为止的全文」重分析一次。
// 所以这里的约定和严格入口相反 —— 永远产出一棵能渲染的树：
//
//   · 末尾没写完的语句     丢掉，记一条恢复诊断（stream）/ 错误（final）
//   · 引用了还没写到的变量 先空着，记进 pending；流结束仍缺才算错误
//   · 中间坏掉的语句       跳过，下一条「变量名 =」继续
//   · 未知组件 / 必填缺失  只摘掉这一个组件，兄弟节点照常渲染
//   · 参数绑不上           只丢这个参数，组件用默认值继续渲染
//   · 同名变量再定义       后者覆盖前者（模型改主意时常见）
//
// root 优先取名为 root 的变量；没有则取第一条定义 —— 和 OpenUI Lang 的约定一致。
// ─────────────────────────────────────────────────────────────────────────────

import type { Definition, Expr, Resolved, UiNode, UiValue } from './ast.ts';
import { bindArguments } from './bind.ts';
import { CODES, error, type Diagnostic, type Pos, warning } from './diagnostics.ts';
import { normalize } from './normalize.ts';
import { parseProgramTolerant } from './parser.ts';
import { lookupComponent } from './registry.ts';
import { computeReachable } from './resolve.ts';

export interface AnalyzeOptions {
  /** true = 流已结束：未写完的语句、悬空引用都升级为错误。默认 false */
  final?: boolean;
  /** 表达式嵌套深度上限，默认 64 */
  maxDepth?: number;
  /** 组件节点总数上限，默认 5000 */
  maxNodes?: number;
  /** 源码长度上限（字符），默认 512 KiB */
  maxSourceLength?: number;
  /** 不进界面、单独取值的变量名（如 summary）：不参与 root 选择，不报未引用 */
  sidecars?: string[];
  /**
   * 流式中占位用的组件名（如 "Placeholder"）。给了它，还没写到的变量、写到一半的组件
   * 在子节点位置（node / nodes 参数）上不再被丢掉，而是换成 `占位组件(目标组件名)`，
   * 界面先留出位置，成品写完再替换，布局不跳。数据参数里的占位直接剔除。final 时不生效。
   */
  placeholder?: string;
}

export interface AnalyzeResult {
  /** 能渲染的根节点；还没有可渲染内容时为 null */
  root: UiNode | null;
  rootName: string | null;
  /** root 可达的具名组件：变量名 → 节点 */
  nodes: Record<string, UiNode>;
  reachable: string[];
  /** 文本里的真问题（错误 + 警告），对应的部分已被摘掉 */
  diagnostics: Diagnostic[];
  /** 流式切口：末尾未写完的语句等。源补全后这些条目会消失 */
  recovery: Diagnostic[];
  /** 被引用、但还没定义的变量名 */
  pending: string[];
  /** 末尾有没写完的语句 */
  partial: boolean;
  definitions: number;
  /** sidecars 里请求的变量：变量名 → 规范化后的值（还没写到的不出现） */
  sidecars: Record<string, UiValue>;
}

const MISSING = Symbol('missing');
type Built = Resolved | typeof MISSING;

const DEFAULTS = { maxDepth: 64, maxNodes: 5000, maxSourceLength: 512 * 1024 } as const;

const CLOSER: Record<string, string> = { '(': ')', '[': ']' };

/**
 * 流式切口补齐：闭合未结束的字符串，按嵌套顺序补上 ) 和 ]。
 * 括号对不上（说明不是简单的切口）时返回 null。
 */
function autoClose(src: string): string | null {
  const stack: string[] = [];
  let quote: string | null = null;
  let danglingEscape = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') {
        if (i === src.length - 1) danglingEscape = true;
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') stack.push(CLOSER[ch]!);
    else if ((ch === ')' || ch === ']') && stack.pop() !== ch) return null;
  }
  let out = danglingEscape ? src.slice(0, -1) : src;
  if (quote) out += quote;
  else if (/=\s*$/.test(out)) return null;
  if (!quote && stack.length === 0) return null;
  return out + stack.reverse().join('');
}

export function analyzeUiDsl(source: string, options: AnalyzeOptions = {}): AnalyzeResult {
  const final = options.final === true;
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const maxNodes = options.maxNodes ?? DEFAULTS.maxNodes;
  const maxSourceLength = options.maxSourceLength ?? DEFAULTS.maxSourceLength;

  const diagnostics: Diagnostic[] = [];
  const recovery: Diagnostic[] = [];
  const empty = (): AnalyzeResult => ({
    root: null,
    rootName: null,
    nodes: {},
    reachable: [],
    diagnostics,
    recovery,
    pending: [],
    partial: false,
    definitions: 0,
    sidecars: {},
  });
  const sidecarNames = new Set(options.sidecars ?? []);

  if (source.length > maxSourceLength) {
    diagnostics.push(error(CODES.SOURCE_TOO_LONG, `源码 ${source.length} 字符，超过上限 ${maxSourceLength}`));
    return empty();
  }

  // ── 词法 + 语法（宽容）──────────────────────────────────────────────────
  let parsed = parseProgramTolerant(source, maxDepth);
  const partial = parsed.incomplete !== null && !final;
  // 流式中：先把末尾那条语句的字符串和括号补齐再试，文字就能边写边显示
  let tailFrom = Infinity;
  if (parsed.incomplete && !final) {
    const closed = autoClose(source);
    const retry = closed === null ? null : parseProgramTolerant(closed, maxDepth);
    if (retry && retry.incomplete === null && retry.errors.length <= parsed.errors.length) {
      tailFrom = parsed.incomplete.offset;
      recovery.push(warning(CODES.INCOMPLETE_STATEMENT, '末尾语句还没写完，临时补齐后渲染', parsed.incomplete));
      parsed = retry;
    }
  }
  for (const e of parsed.errors) diagnostics.push(error(e.code, e.message, e.pos));
  if (parsed.incomplete) {
    const make = final ? error : warning;
    (final ? diagnostics : recovery).push(
      make(CODES.INCOMPLETE_STATEMENT, final ? '最后一条语句没有写完，已丢弃' : '切在未写完的语句之前', parsed.incomplete),
    );
  }

  // ── 定义收集：后写的覆盖先写的 ──────────────────────────────────────────
  const byName = new Map<string, Definition>();
  for (const def of parsed.definitions) {
    const prev = byName.get(def.name);
    if (prev) {
      diagnostics.push(
        warning(CODES.REDEFINED, `变量 ${JSON.stringify(def.name)} 重复定义，以第 ${def.pos.line} 行为准（先前在第 ${prev.pos.line} 行）`, def.pos),
      );
      byName.delete(def.name); // 保持「最后定义」的源码顺序
    }
    byName.set(def.name, def);
  }

  const rootName = byName.has('root') ? 'root' : (parsed.definitions.find((d) => !sidecarNames.has(d.name))?.name ?? null);
  if (!rootName) {
    if (final && source.trim() !== '') diagnostics.push(error(CODES.MISSING_ROOT, '没有任何定义：至少需要一行 root = ...'));
    return { ...empty(), partial };
  }

  // ── 解析 + 绑定 + 摘除（一趟完成）──────────────────────────────────────
  const cache = new Map<string, Built>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const pending = new Map<string, Pos>();
  let nodeCount = 0;
  let budgetReported = false;

  // ── 流式占位 ──────────────────────────────────────────────────────────────
  const placeholderName = !final && options.placeholder ? options.placeholder : null;
  /** 占位节点（按对象身份识别） */
  const placeholders = new WeakSet<object>();

  function makePlaceholder(of: string, pos: Pos, name = ''): Resolved {
    const arg: Resolved = { kind: 'literal', value: of, pos };
    const node: Resolved = { kind: 'node', name, component: placeholderName!, args: [arg], pos, slots: [arg] };
    placeholders.add(node);
    return node;
  }

  /** 占位只留在子节点位置：数据参数、sidecar 里的占位剔除（数组里的一并清掉） */
  function stripPlaceholders(v: Resolved): Resolved | null {
    if (placeholders.has(v)) return null;
    if (v.kind !== 'array') return v;
    const items = v.items.map(stripPlaceholders).filter((x): x is Resolved => x !== null);
    return items.length === v.items.length ? v : { ...v, items };
  }

  function resolveRef(name: string, pos: Pos): Built {
    if (cache.has(name)) return cache.get(name)!;
    if (onStack.has(name)) {
      const path = stack.slice(stack.indexOf(name)).concat(name);
      diagnostics.push(error(CODES.CYCLIC_REFERENCE, `变量引用成环：${path.join(' -> ')}`, pos));
      return MISSING;
    }
    const def = byName.get(name);
    if (!def) {
      if (!pending.has(name)) pending.set(name, pos);
      return placeholderName ? makePlaceholder('', pos, name) : MISSING;
    }
    onStack.add(name);
    stack.push(name);
    const value = build(def.value);
    stack.pop();
    onStack.delete(name);
    const named: Built = value !== MISSING && value.kind === 'node' ? { ...value, name } : value;
    if (value !== MISSING && placeholders.has(value)) placeholders.add(named as Resolved);
    cache.set(name, named);
    return named;
  }

  function build(e: Expr): Built {
    switch (e.kind) {
      case 'string':
      case 'number':
      case 'boolean':
        return { kind: 'literal', value: e.value, pos: e.pos };
      case 'null':
        return { kind: 'literal', value: null, pos: e.pos };
      case 'ref':
        return resolveRef(e.name, e.pos);
      case 'array': {
        const items: Resolved[] = [];
        for (const it of e.items) {
          const v = build(it);
          if (v !== MISSING) items.push(v);
        }
        return { kind: 'array', items, pos: e.pos };
      }
      case 'call':
        return buildCall(e);
    }
  }

  function buildCall(e: Expr & { kind: 'call' }): Built {
    nodeCount += 1;
    if (nodeCount > maxNodes) {
      if (!budgetReported) {
        diagnostics.push(error(CODES.NODE_BUDGET_EXCEEDED, `组件节点超过上限 ${maxNodes}，其余部分不再展开`, e.pos));
        budgetReported = true;
      }
      return MISSING;
    }
    const spec = lookupComponent(e.component);
    if (!spec) {
      diagnostics.push(error(CODES.UNKNOWN_COMPONENT, `目录里没有组件 ${JSON.stringify(e.component)}`, e.pos));
      return MISSING;
    }

    // 还没写到的引用占成 null：位置对齐不受影响，可选参数走默认值
    let waiting = false;
    const built = e.args.map(build);
    const args: Resolved[] = built.map((v, i) => {
      if (v !== MISSING && !placeholders.has(v)) return v;
      waiting = true;
      return { kind: 'literal', value: null, pos: e.args[i]!.pos };
    });

    let bound = bindArguments(spec, args, e.pos);
    // 占位多半等的是子组件：先让它以节点身份去绑（落到 node 参数上）；绑出了错（其实等的是文字 / 数字）再退回 null
    if (placeholderName && built.some((v) => v !== MISSING && placeholders.has(v))) {
      const asNodes = bindArguments(spec, built.map((v, i) => (v !== MISSING && placeholders.has(v) ? v : args[i]!)), e.pos);
      if (asNodes.diagnostics.every((d) => d.code === CODES.MISSING_REQUIRED_ARG)) bound = asNodes;
    }
    for (const d of bound.diagnostics) {
      if (d.code !== CODES.MISSING_REQUIRED_ARG) diagnostics.push(d);
    }
    if (placeholderName) {
      spec.params.forEach((param, i) => {
        const slot = bound.slots[i];
        if (slot && param.type !== 'nodes' && param.type !== 'node') bound.slots[i] = stripPlaceholders(slot);
      });
    }

    const missing = spec.params.findIndex((p, i) => {
      if (!p.required) return false;
      const slot = bound.slots[i];
      return slot === undefined || slot === null || (slot.kind === 'literal' && slot.value === null);
    });
    if (missing !== -1) {
      const param = spec.params[missing]!;
      // 必填项等的是一个还没写到的变量：流式中的正常状态，不算错
      if (!(waiting && !final)) {
        diagnostics.push(error(CODES.DROPPED_COMPONENT, `${spec.name} 缺少必填参数 ${param.name}，整个组件被摘掉`, e.pos));
      }
      // 还在写的组件（等变量，或就是末尾那条没写完的语句）：先按它的样子占位
      if (placeholderName && !spec.data && (waiting || e.pos.offset >= tailFrom)) return makePlaceholder(spec.name, e.pos);
      return MISSING;
    }

    return { kind: 'node', name: '', component: e.component, args, pos: e.pos, slots: bound.slots };
  }

  for (const def of byName.values()) resolveRef(def.name, def.pos);

  const rootBuilt = cache.get(rootName) ?? MISSING;
  let root: UiNode | null = null;
  if (rootBuilt !== MISSING) {
    if (rootBuilt.kind === 'node') root = normalize(rootBuilt) as UiNode;
    else diagnostics.push(error(CODES.ROOT_NOT_COMPONENT, `${rootName} 必须是一个组件调用，例如 Stack([...])`, byName.get(rootName)!.pos));
  }

  const reachable = computeReachable(byName, rootName);
  const nodes: Record<string, UiNode> = {};
  for (const name of reachable) {
    const b = cache.get(name);
    if (b && b !== MISSING && b.kind === 'node') nodes[name] = normalize(b) as UiNode;
  }

  if (final) {
    for (const [name, pos] of pending) {
      diagnostics.push(error(CODES.UNDEFINED_REFERENCE, `引用了未定义的变量 ${JSON.stringify(name)}`, pos));
    }
    for (const [name, def] of byName) {
      if (!reachable.includes(name) && !sidecarNames.has(name)) {
        diagnostics.push(warning(CODES.UNUSED_DEFINITION, `变量 ${JSON.stringify(name)} 没有被 ${rootName} 引用，不会显示`, def.pos));
      }
    }
  }

  // 临时补齐的那条语句里冒出来的问题（半截枚举值、还没写参数的组件）属于切口，不是错误
  const settled = diagnostics.filter((d) => !(d.pos && d.pos.offset >= tailFrom));
  for (const d of diagnostics) if (d.pos && d.pos.offset >= tailFrom) recovery.push({ ...d, severity: 'warning' });

  return {
    root,
    rootName,
    nodes,
    reachable,
    diagnostics: settled,
    recovery,
    pending: [...pending.keys()],
    partial,
    definitions: byName.size,
    sidecars: Object.fromEntries(
      [...sidecarNames].flatMap((name) => {
        const b = cache.get(name);
        const kept = b && b !== MISSING ? stripPlaceholders(b) : null;
        return kept ? [[name, normalize(kept)]] : [];
      }),
    ),
  };
}
