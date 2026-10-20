// ─────────────────────────────────────────────────────────────────────────────
// 组件定义工具
//
// 一个组件 = 一个文件（components/<Name>.js），里面写齐三样：
//   · 签名   params —— 位置参数的顺序就是 OpenUI Lang 里的实参顺序
//   · 渲染   render —— { create(props, ctx) → 元素, update?(el, props, prev, ctx) }
//   · 样式   css    —— 可选，渲染器启动时注入一次（几个组件共用的写在 styles.js）
//   · 退化   markdown(props) → 文字 —— 可选，给跑不动程序的客户端；不写就只展开子组件
//
// 解析器的注册表、system prompt、渲染器都从这些定义派生，没有第二份清单。
// ─────────────────────────────────────────────────────────────────────────────

import { TEXT_STYLES, TEXT_COLORS, TEXT_SIZES, TEXT_WEIGHTS } from './tokens.js';

export const PARAM_TYPES = ['nodes', 'node', 'string', 'number', 'boolean', 'enum', 'array', 'space'];

const p = (name, type, opts = {}) => ({ name, type, required: false, ...opts });

/** 子组件数组：Stack([a, b]) */
export const nodes = (name, opts) => p(name, 'nodes', opts);
/** 单个子组件：FormControl("姓名", Input(...)) */
export const node = (name, opts) => p(name, 'node', opts);
export const str = (name, opts) => p(name, 'string', opts);
export const num = (name, opts) => p(name, 'number', opts);
export const bool = (name, opts) => p(name, 'boolean', opts);
export const enumOf = (name, values, opts = {}) => p(name, 'enum', { enum: values, ...opts });
export const style = (name = 'style', def = 'default') => enumOf(name, TEXT_STYLES, { default: def });
/** 文字颜色 / 字号 / 粗细：语义名枚举，不给默认值（不写就沿用 style 预设或外层文字） */
export const textColor = (name = 'color') => enumOf(name, TEXT_COLORS);
export const textSize = (name = 'size') => enumOf(name, TEXT_SIZES);
export const textWeight = (name = 'weight') => enumOf(name, TEXT_WEIGHTS);
/** 间距：接受 token 名（"m"）或刻度序号（3 → 12px），编译期归一成像素 */
export const space = (name, def) => p(name, 'space', { default: def });
/** 数据数组：字面量，或数据型组件（Series / Slice / Col / SelectItem / Span），编译成普通对象 */
export const list = (name, opts) => p(name, 'array', opts);

/**
 * 登记一个组件。形状不对立刻抛错 —— 新组件写错了在启动时就暴露，
 * 而不是等模型用到它时才在界面上出「未知组件」。
 *
 * @param {object} def
 * @param {string} def.name          组件名，PascalCase
 * @param {string} def.group         提示词里的分组
 * @param {string} def.description   给模型看的一句话说明
 * @param {object[]} def.params      位置参数
 * @param {object} [def.render]      渲染实现 { create, update?, updates? }；数据型组件可省略。
 *                                   有 update 时 updates 列出它原位处理的属性，其余属性变化整块重建
 * @param {string} [def.css]         组件自带样式
 * @param {(props: object) => string} [def.markdown] 退化成 Markdown 的写法
 * @param {boolean} [def.data]       数据型组件：只作为数组参数里的数据，不渲染
 * @param {boolean} [def.typed]      数据型组件编成对象时带上 __type: 组件名（同一数组里混放多种数据型组件时用，如 Drawing 的图元）
 * @param {boolean} [def.serverResolved] 值由服务端解析（图片 / 实体 / 引用）
 * @param {object} [def.skeleton]    流式中还没写完时占位骨架的形状，尽量和成品等大，免得界面跳：
 *                                   { lines?: 行数, h?: 固定高度 px, ratio?: "16 / 9", frame?: 带边框的卡片外形,
 *                                     inline?: 行内小块, w?: 行内宽度 px }
 * @param {boolean} [def.internal]   内部组件：编译器自己生成，不进 OpenUI Lang 注册表和提示词，模型写不出来
 * @param {string} [def.skill]       所属技能（skills/ 里的 id）：只有用户选中该技能、或当前画布已经用到它时，
 *                                   组件说明才进提示词。解析和渲染不受影响，历史画布永远画得出来
 */
export function defineComponent(def) {
  const where = `组件 ${def && def.name}`;
  if (!def || !/^[A-Z][A-Za-z0-9]*$/.test(def.name || '')) throw new Error(`${where}：name 必须是 PascalCase`);
  if (!def.group) throw new Error(`${where}：缺少 group`);
  if (!def.description) throw new Error(`${where}：缺少 description`);
  if (!Array.isArray(def.params)) throw new Error(`${where}：params 必须是数组`);
  const seen = new Set();
  for (const param of def.params) {
    if (!PARAM_TYPES.includes(param.type)) throw new Error(`${where}：参数 ${param.name} 的类型 ${param.type} 不合法`);
    if (seen.has(param.name)) throw new Error(`${where}：参数 ${param.name} 重复`);
    if (param.type === 'enum' && !(Array.isArray(param.enum) && param.enum.length)) throw new Error(`${where}：枚举参数 ${param.name} 没有取值`);
    seen.add(param.name);
  }
  if (!def.data && !(def.render && typeof def.render.create === 'function')) {
    throw new Error(`${where}：需要 render.create（数据型组件请标 data: true）`);
  }
  if (def.markdown != null && typeof def.markdown !== 'function') throw new Error(`${where}：markdown 必须是函数`);
  if (def.css != null && typeof def.css !== 'string') throw new Error(`${where}：css 必须是字符串`);
  if (def.skill != null && !/^[a-z][a-z0-9-]*$/.test(def.skill)) throw new Error(`${where}：skill 必须是小写 id`);
  if (def.skeleton != null) {
    const s = def.skeleton;
    if (typeof s !== 'object') throw new Error(`${where}：skeleton 必须是对象`);
    const known = ['lines', 'h', 'ratio', 'frame', 'inline', 'w'];
    const extra = Object.keys(s).filter((k) => !known.includes(k));
    if (extra.length) throw new Error(`${where}：skeleton 不认识 ${extra.join(', ')}`);
  }
  if (def.render && def.render.update) {
    const updates = def.render.updates;
    if (!Array.isArray(updates)) throw new Error(`${where}：有 render.update 就要用 render.updates 列出它原位处理的属性`);
    for (const k of updates) if (!seen.has(k)) throw new Error(`${where}：render.updates 里的 ${k} 不是参数`);
  }
  return Object.freeze(def);
}
