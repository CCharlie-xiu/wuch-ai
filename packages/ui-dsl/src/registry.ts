// ─────────────────────────────────────────────────────────────────────────────
// 组件注册表：OpenUI Lang 允许出现的组件及其【位置参数】契约
//
// 直接从 @openui-lab/catalog 派生 —— 每个组件文件里的 params 就是契约本身，
// 新增组件只需在 catalog 里加文件，解析器这一侧零改动。
//
// 参数顺序是契约：调整已有组件的参数顺序会让旧的 OpenUI Lang 文本改变含义。
// 这件事由 fixtures 的端到端测试兜住（预置界面编译出诊断就会失败）。
// ─────────────────────────────────────────────────────────────────────────────

import { COMPONENTS, MAX_WIDTHS as CATALOG_MAX_WIDTHS, SPACE_TOKENS as CATALOG_SPACE_TOKENS, TEXT_STYLES as CATALOG_TEXT_STYLES } from '@openui-lab/catalog';

/** 与 catalog 的参数类型一一对应 */
export type ParamType =
  | 'nodes' // 子节点数组
  | 'node' // 单个子节点
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'array' // 数据数组（options / rules / cols / rows / series）
  | 'space'; // 间距：接受 token 名（"m"）或刻度序号（3）

export interface ParamSpec {
  name: string;
  type: ParamType;
  /** 必填 = 位置必须给出实参，且不能是 null */
  required: boolean;
  /** catalog 里声明的默认值（编译期填充，解析层不使用） */
  default?: string | number | boolean;
  /** type === 'enum' 时的合法取值 */
  enum?: readonly string[];
}

export interface ComponentSpec {
  name: string;
  group: string;
  /** 数据型组件：只能出现在 array 参数里，编译成普通对象 */
  data: boolean;
  params: readonly ParamSpec[];
}

/** TOKENS.gap 的键 —— 'space' 类型接受的 token 名 */
export const SPACE_TOKENS: readonly string[] = CATALOG_SPACE_TOKENS;
/** TOKENS.text 的键 */
export const TEXT_STYLES: readonly string[] = CATALOG_TEXT_STYLES;
/** TOKENS.maxWidth 的键 */
export const MAX_WIDTHS: readonly string[] = CATALOG_MAX_WIDTHS;

function build(): ReadonlyMap<string, ComponentSpec> {
  const map = new Map<string, ComponentSpec>();
  for (const c of COMPONENTS) {
    if (c.internal) continue;
    map.set(c.name, {
      name: c.name,
      group: c.group,
      data: c.data === true,
      params: c.params.map((p) => {
        const spec: ParamSpec = { name: p.name, type: p.type, required: p.required === true };
        if (p.default !== undefined) spec.default = p.default as string | number | boolean;
        if (p.enum) spec.enum = p.enum;
        return spec;
      }),
    });
  }
  return map;
}

export const REGISTRY: ReadonlyMap<string, ComponentSpec> = build();

/** 允许的组件名（注册表就是白名单 —— 目录外的组件一律拒绝） */
export const REGISTERED_COMPONENTS: readonly string[] = [...REGISTRY.keys()];

/** `组件名.参数名` → 枚举取值 */
export const ENUMS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  [...REGISTRY.values()].flatMap((c) => c.params.filter((p) => p.enum).map((p) => [`${c.name}.${p.name}`, p.enum!])),
);

export const lookupComponent = (name: string): ComponentSpec | undefined => REGISTRY.get(name);
