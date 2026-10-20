// ─────────────────────────────────────────────────────────────────────────────
// 实参绑定：把一串位置实参对到注册表声明的参数槽上
//
// ── 为什么需要这一层 ────────────────────────────────────────────────────────
//
// 目录里存在「夹在中间的可选参数」，最典型的是 Input / TextArea / Select：
//
//   Input(name, placeholder, type, value, rules)
//                                   ↑ 可选，但排在 rules 前面
//
// 作者想表达「只要校验规则、不预设 value」，在纯位置参数下只有两条路：
//   · 硬写 null 占位：Input("name", "ph", "text", null, ["required"])
//   · 让绑定器按类型判断：Input("name", "ph", "text", ["required"])
//
// 第二条更好用，也更符合「位置参数 → 具名 props 由编译器完成」这个目录原本的意图。
// 于是绑定规则是：
//
//   1. 优先绑在当前游标处 —— 类型匹配就用它，不做任何猜测。
//   2. 当前槽不匹配时，向后找第一个类型匹配的槽。**只能跳过可选参数**，
//      且跳过的槽一律记成 null（显式缺省），这样「实参下标 ↔ 参数下标」的
//      对齐关系不破，下游（渲染器）仍可按下标取值。
//   3. 找不到任何匹配的槽 → 报错，并且报在**游标处那个参数**上 ——
//      这是最能让作者看懂的位置。
//
// ── 两条守卫，防止「静默绑错」──────────────────────────────────────────────
//
// 按类型跳过有一个固有风险：某个实参本意是往前绑，却被跳到后面去了。
// 两类情况必须挡住：
//
//   · 必填参数不能被跳过。CardHeader(123) 里 123 绑不到 title(string)，
//     又越不过必填的 title，于是报错，而不是溜到 subtitle 去。
//   · **枚举参数遇到字符串不匹配时不跳过。** "textt" 这种给错枚举值是最
//     常见的拼写错误；若允许跳过，它会被静默绑到后面的 value(string) 上，
//     错得毫无痕迹。所以这里宁可报错。
//     例外：落点本身也是枚举 —— 能落下说明这个字符串恰好是那个枚举的合法取值，
//     不是拼写错误。TextContent("x", "primary") 因此能越过 style 绑到 color。
//
// 反过来，非枚举参数的类型不符允许跳过 —— 那是「跳过这个可选参数」的正常表达。
// ─────────────────────────────────────────────────────────────────────────────

import type { Resolved } from './ast.ts';
import { CODES, error, type Diagnostic, type Pos } from './diagnostics.ts';
import { SPACE_TOKENS, type ComponentSpec, type ParamSpec } from './registry.ts';

// ── 类型判定：绑定与报错共用同一份逻辑，避免两处漂移 ───────────────────────
export const isNullLiteral = (v: Resolved): boolean => v.kind === 'literal' && v.value === null;
export const isStringLiteral = (v: Resolved): boolean =>
  v.kind === 'literal' && typeof v.value === 'string';

/** 这个实参能不能放到这个参数槽上（null 视作「显式缺省」，任何槽都接受） */
export function accepts(param: ParamSpec, arg: Resolved): boolean {
  switch (param.type) {
    case 'node':
      return arg.kind === 'node';
    case 'nodes':
      return arg.kind === 'array' && arg.items.every((it) => it.kind === 'node');
    case 'array':
      return arg.kind === 'array';
    default:
      break;
  }

  if (arg.kind !== 'literal') return false;
  const v = arg.value;
  if (v === null) return true; // 显式缺省

  switch (param.type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'enum':
      return typeof v === 'string' && (param.enum ?? []).includes(v);
    case 'space':
      return (
        (typeof v === 'number' && Number.isFinite(v)) ||
        (typeof v === 'string' && (SPACE_TOKENS as readonly string[]).includes(v))
      );
    default:
      return false;
  }
}

export interface BindResult {
  /**
   * 与 spec.params 等长、下标对齐。undefined = 该参数没被提供（尾部）；
   * null = 显式缺省或被跳过。消费方按 !slot 判断「走默认值」即可。
   */
  slots: (Resolved | null | undefined)[];
  /** 被跳过的参数下标（用于 reportSkippedArguments 与测试） */
  skipped: number[];
  diagnostics: Diagnostic[];
}

function skipAllowed(param: ParamSpec, arg: Resolved, target: ParamSpec): boolean {
  if (param.required) return false; // 守卫一：必填不能跳过
  // 守卫二：枚举拼写错误；落点也是枚举时字符串已被它精确接住，不算拼错
  if (param.type === 'enum' && isStringLiteral(arg) && target.type !== 'enum') return false;
  return true;
}

const slotName = (param: ParamSpec, index: number): string => `第 ${index + 1} 个参数 ${param.name}`;

export function bindArguments(spec: ComponentSpec, args: readonly Resolved[], at: Pos): BindResult {
  const params = spec.params;
  const slots: (Resolved | null | undefined)[] = new Array(params.length).fill(undefined);
  const skipped: number[] = [];
  const diagnostics: Diagnostic[] = [];
  let cursor = 0;

  const reportUnbindable = (ai: number, arg: Resolved): void => {
    // 用与校验同源的诊断：报在游标处那个参数上，这是最能让作者看懂的位置
    const diag = slotDiagnostic(spec.name, params[cursor]!, cursor, arg);
    diagnostics.push(
      diag ?? error(CODES.ARG_TYPE, `${spec.name} 的第 ${ai + 1} 个实参绑不上任何参数`, arg.pos),
    );
  };

  for (let ai = 0; ai < args.length; ai++) {
    const arg = args[ai]!;

    if (cursor >= params.length) {
      // 两种情形必须分开说，否则会报出自相矛盾的话：
      //   · 实参真的比参数多 —— 报总数
      //   · 实参数没超，但槽已经用完 —— 是前面「跳过可选参数」把后面的槽提前吃掉了
      //     （Sheet("ds","Sheet1","A,B","1,2",true,"标题")：两个字符串跳过 cols/rows
      //      落到 caption，游标一下走到头，第 3 个实参就没地方放了）。
      //     这时只报总数会写成「最多接受 6 个参数，实际给了 6 个」，作者完全看不懂。
      const names = params.map((p) => p.name).join(' / ');
      diagnostics.push(
        args.length > params.length
          ? error(
              CODES.ARG_COUNT,
              `${spec.name} 最多接受 ${params.length} 个参数，实际给了 ${args.length} 个`,
              at,
            )
          : error(
              CODES.ARG_TYPE,
              `${spec.name} 的第 ${ai + 1} 个实参 ${describeArg(arg)} 放不下：${params.length} 个参数槽已经用完` +
                `（${names}）。前面有实参跳过了可选参数，把后面的槽提前占掉了 —— 检查这一段实参的顺序与类型`,
              arg.pos,
            ),
      );
      break;
    }

    // 1) 先试当前游标：类型匹配就用它，不做任何猜测
    if (accepts(params[cursor]!, arg)) {
      slots[cursor] = arg;
      cursor += 1;
      continue;
    }

    // 2) 当前槽接不住：向后找第一个能接住的槽
    let target = -1;
    for (let pi = cursor + 1; pi < params.length; pi++) {
      if (accepts(params[pi]!, arg)) {
        target = pi;
        break;
      }
    }

    if (target === -1) {
      reportUnbindable(ai, arg);
      break;
    }

    // 3) 途中经过的槽必须全是「可跳过的可选参数」
    const between = Array.from({ length: target - cursor }, (_, k) => cursor + k);
    const blocked = between.find((pi) => !skipAllowed(params[pi]!, arg, params[target]!));
    if (blocked !== undefined) {
      reportUnbindable(ai, arg);
      break;
    }

    for (const pi of between) {
      slots[pi] = null; // 显式缺省：保住下标对齐
      skipped.push(pi);
    }
    slots[target] = arg;
    cursor = target + 1;
  }

  // 尾部缺失的必填参数
  for (let pi = 0; pi < params.length; pi++) {
    const param = params[pi]!;
    if (slots[pi] === undefined && param.required) {
      diagnostics.push(
        error(CODES.MISSING_REQUIRED_ARG, `${spec.name} 缺少必填的${slotName(param, pi)}`, at),
      );
    }
  }

  return { slots, skipped, diagnostics };
}

// ── 供 validate.ts 生成可读信息（与 accepts 同一套类型认知）─────────────────
export function describeParam(param: ParamSpec): string {
  switch (param.type) {
    case 'nodes':
      return '节点数组（[...]）';
    case 'node':
      return '单个组件节点';
    case 'array':
      return '数组';
    case 'space':
      return `间距（${SPACE_TOKENS.join(' / ')} 或数字）`;
    case 'enum':
      return `枚举（${(param.enum ?? []).join(' / ')}）`;
    case 'string':
      return '字符串';
    case 'number':
      return '数字';
    default:
      return '布尔值';
  }
}

export function describeArg(v: Resolved): string {
  switch (v.kind) {
    case 'literal':
      if (v.value === null) return 'null';
      return `${typeof v.value} ${JSON.stringify(v.value)}`;
    case 'array':
      return `数组（${v.items.length} 项）`;
    case 'node':
      return `组件 ${v.component}`;
  }
}

/**
 * 某个实参放在某个参数槽上「错在哪」—— 绑定阶段与校验阶段共用这一份，
 * 避免两个地方各写一套消息而慢慢漂移。
 * 返回 null 表示没问题。
 */
export function slotDiagnostic(
  component: string,
  param: ParamSpec,
  index: number,
  arg: Resolved,
): Diagnostic | null {
  if (accepts(param, arg)) return null;

  const where = `${component} 的第 ${index + 1} 个参数 ${param.name}`;

  if (param.type === 'enum') {
    const v = arg.kind === 'literal' ? arg.value : undefined;
    return error(
      CODES.ARG_TYPE,
      `${where}取值不合法：${JSON.stringify(v)}；允许 ${(param.enum ?? []).join(' / ')}`,
      arg.pos,
    );
  }

  if (param.type === 'nodes' && arg.kind === 'array') {
    const bad = arg.items.find((it) => it.kind !== 'node');
    if (bad) {
      return error(
        CODES.ARG_TYPE,
        `${where}里出现了 ${describeArg(bad)}；节点数组的元素必须都是组件节点`,
        bad.pos,
      );
    }
  }

  return error(
    CODES.ARG_TYPE,
    `${where}期待${describeParam(param)}，实际是 ${describeArg(arg)}`,
    arg.pos,
  );
}
