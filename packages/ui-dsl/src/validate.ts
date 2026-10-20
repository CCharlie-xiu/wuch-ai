// ─────────────────────────────────────────────────────────────────────────────
// 校验：拿着注册表检查解析后的树
//
// 四件事：
//   1. root 必须是组件节点（不能是一段文字或一个数组）
//   2. 组件必须在注册表内（未登记 = 拒绝，这是 DSL 的白名单边界）
//   3. 实参绑定：能不能对到参数槽上（见 bind.ts 的规则与两条守卫）
//   4. 参数类型：已绑定槽逐个查类型
//
// 绑定规则（含「按类型跳过可选参数」）全部在 bind.ts，这里只做检查与串接。
// 校验过程中会把绑定结果（slots）挂回节点上，供 index.ts 规范化时复用 ——
// 这样「绑定」只发生一次，不会出现两处各算一遍的漂移。
//
// 一条已知的宽松处（见 DESIGN.md 的「已知限制」）：
//   catalog 把 rules / options 都声明为 'array'，没有区分元素类型。
//   所以 'array' 这里接受「字面量或组件节点」的任意组合，不做元素级收紧。
//   收紧需要改 catalog（会改变语义），v1 不动。
// ─────────────────────────────────────────────────────────────────────────────

import type { Resolved } from './ast.ts';
import { bindArguments, describeArg, isNullLiteral, slotDiagnostic } from './bind.ts';
import { CODES, error, type Diagnostic } from './diagnostics.ts';
import { lookupComponent as lookup } from './registry.ts';

function walk(
  value: Resolved,
  out: Diagnostic[],
  seen: WeakSet<object>,
  reportSkipped: boolean,
  depth: number,
): void {
  if (depth > 512) return; // 兜底：解析阶段已限深，这里只防意外

  if (value.kind === 'array') {
    for (const item of value.items) walk(item, out, seen, reportSkipped, depth + 1);
    return;
  }
  if (value.kind !== 'node') return;

  // 同一节点可能被多处引用（变量内联），只校验一次，避免重复诊断
  if (seen.has(value)) return;
  seen.add(value);

  const spec = value.component ? lookup(value.component) : undefined;

  if (!spec) {
    out.push(
      error(
        CODES.UNKNOWN_COMPONENT,
        `未注册的组件 ${JSON.stringify(value.component)}（DSL v1 允许的组件见 registry.ts）`,
        value.pos,
      ),
    );
    // 组件不认识，参数类型无从判定；但仍往下走，把嵌套的未知组件一并找出来
    for (const arg of value.args) walk(arg, out, seen, reportSkipped, depth + 1);
    return;
  }

  const bound = bindArguments(spec, value.args, value.pos);
  out.push(...bound.diagnostics);

  // 绑定结果挂回节点：index.ts 规范化时直接复用，不再重算
  value.slots = bound.slots;

  if (reportSkipped) {
    for (const pi of bound.skipped) {
      const param = spec.params[pi]!;
      out.push({
        severity: 'warning',
        code: CODES.SKIPPED_OPTIONAL,
        message: `${spec.name} 的可选参数「${param.name}」被跳过（第 ${pi + 1} 个参数），该位置按下标对齐记作 null`,
        pos: value.pos,
      });
    }
  }

  const where = value.name ? `${value.component}（变量 ${value.name}）` : value.component;

  for (let i = 0; i < spec.params.length; i++) {
    const param = spec.params[i]!;
    const slot = bound.slots[i];

    // 两种情况都是「这一槽没有实参」：
    //   undefined = 尾部没提供（必填的缺失已由绑定器报过，这里不重复）
    //   JS null   = 被绑定器跳过（跳过的必是可选参数）
    if (slot === undefined || slot === null) continue;

    // 作者显式写了 null：可选参数 = 显式缺省；必填参数 = 报错。
    // 注意这里判的是 Resolved 里的 null 字面量对象，不是 JS null —— 两者含义不同。
    if (isNullLiteral(slot)) {
      if (param.required) {
        out.push(
          error(
            CODES.ARG_TYPE,
            `${where} 的第 ${i + 1} 个参数 ${param.name} 是必填，不能为 null`,
            slot.pos,
          ),
        );
      }
      continue;
    }

    const diag = slotDiagnostic(value.component, param, i, slot);
    if (diag) out.push(diag);
  }

  // 递归进所有实参（含绑定失败的），把嵌套问题一并找出来
  for (const arg of value.args) walk(arg, out, seen, reportSkipped, depth + 1);
}

/** root 必须是组件节点 */
function checkRoot(root: Resolved): Diagnostic | null {
  if (root.kind === 'node') return null;
  if (root.kind === 'array') {
    return error(
      CODES.ROOT_NOT_COMPONENT,
      'root 必须是一个组件节点（例如 Stack(...)）；实际是一个数组。数组只能作为参数出现',
      root.pos,
    );
  }
  return error(
    CODES.ROOT_NOT_COMPONENT,
    `root 必须是一个组件节点，实际是 ${describeArg(root)}`,
    root.pos,
  );
}

export function validateTree(root: Resolved, options: { reportSkipped?: boolean } = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const rootDiag = checkRoot(root);
  if (rootDiag) {
    out.push(rootDiag);
    return out; // 根不是节点，没有可继续校验的树
  }
  walk(root, out, new WeakSet(), options.reportSkipped === true, 0);
  return out;
}
