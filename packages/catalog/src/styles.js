// ─────────────────────────────────────────────────────────────────────────────
// 组件共用样式：几个组件共用的「家族」样式放这里，只属于一个组件的写在它自己文件的 css 里。
// 渲染器先注入这份，再注入各组件的 css。
//
// 颜色、边框一律用宿主页面 :root 上的 CSS 变量（--text / --border / --accent …），
// 换主题只改宿主页面，不碰组件。
// ─────────────────────────────────────────────────────────────────────────────

import { CHART_CSS } from './echarts.js';
import { CODE_CSS } from './code.js';
import { TOKENS } from './tokens.js';

const rules = (attr, table, prop, unit = '') =>
  Object.entries(table).map(([k, v]) => `.tx[data-${attr}="${k}"] { ${prop}: ${v}${unit}; }`).join('\n');

export const BASE_CSS = `
/* 方向 005：三层边界，每一层只用一种手段
 *
 * 以前所有边界都是同一种 1px 线：卡片外框、表格外框、单元格网格、指标卡外框，
 * 粗细深浅全一样。眼睛分不出「这是一块」和「这是块里的两行」，整页就散。
 *
 * 现在按「离眼睛多近」分三层，每层只准用一套 token：
 *   ① 块     Card / Table / Sheet / Audio / CodeBlock …  底色 --ui-band，不描边
 *   ② 块内  行、表头、列表项之间的分隔                   发丝线 --ui-line
 *   ③ 控件  按钮 / 输入框 / 胶囊 / 开关 / 白底画布        细线 --ui-line-strong
 *
 * 为什么控件单独一层：它们本身就比背景亮一档（白底、白胶囊），底色差用不上，
 * 只能靠一条线交代「这里可以点」。但线要细、要浅，不能和中层分隔线抢。
 */
:root {
  --ui-radius: 20px;
  /* ① 块级底色：比画布暗一档，刚好能围出一个区域，但不构成「卡片」 */
  --ui-band: rgba(17, 24, 39, .035);
  --ui-band-strong: rgba(17, 24, 39, .07);
  /* ② 块内发丝线：只用于行之间 / 表头下方 */
  --ui-line: rgba(17, 24, 39, .06);
  /* ③ 控件边线：按钮、输入框、胶囊、开关 —— 底色差交代不了的才用它 */
  --ui-line-strong: rgba(17, 24, 39, .1);
  --ui-ink-2: #5b6472;
  /* 三级文字：#98a1b0 在灰底上只有 2.7:1 —— 标签、轴刻度、说明会「看不清」。
     压到 #79828f（4.3:1），仍比正文浅，但读得出来 */
  --ui-ink-3: #79828f;
}
/* 图标（dom.js 的 icon()） */
.icon { width: 16px; height: 16px; flex: 0 0 auto; }
.icon.sm { width: 14px; height: 14px; }
.icon.xs { width: 12px; height: 12px; }
/* 组件区内统一的字号阶梯：只在系统无衬线里取标准字重，避免合成粗体发虚 */
strong { font-weight: 650; }

/* 小号文字：TextContent / IconText */
.text[data-style="small"], .icon-text[data-style="small"] { font-size: 12px; color: var(--ui-ink-2); }

/* 文字颜色 / 字号 / 粗细：TextContent / RichText / Span（dom.js 的 textAttrs()），写在 style 预设之后才能覆盖它 */
${rules('tc', TOKENS.textColor, 'color')}
${rules('ts', TOKENS.textSize, 'font-size', 'px')}
${rules('tw', TOKENS.textWeight, 'font-weight')}

/* 提示框：浅底 + 左侧色条。色条是唯一承载语义的东西，所以留给它 3px；
 * 外框那条同权重线去掉 —— 底色已经说明「这是一块提示」 */
.callout { border: 0; border-left: 3px solid var(--ui-line-strong, rgba(17,24,39,.1)); border-radius: 12px; padding: 12px 15px; background: var(--ui-band, rgba(17,24,39,.035)); display: flex; flex-direction: column; gap: 4px; }
.callout[data-variant="neutral"] { border-left-color: var(--ui-line-strong, rgba(17,24,39,.1)); }
.callout[data-variant="info"] { border-left-color: var(--info, #175cd3); }
.callout[data-variant="success"] { border-left-color: var(--ok, #067647); }
.callout[data-variant="warning"] { border-left-color: var(--warn, #b54708); }
.callout[data-variant="danger"] { border-left-color: var(--danger, #b42318); }
.callout-title { font-weight: 600; font-size: 12.5px; }
.callout-text { font-size: 12.5px; line-height: 1.65; color: var(--ui-ink-2); }

/* 标签：Tag / IconTag */
/* 标签：Tag / IconTag
 * 中性标签用底色（--ui-band-strong）而不是描边：胶囊太小，1px 线在小尺寸上会变成噪点。
 * 只有 outline 变体用细线 —— 那是「我想让它看起来更轻」的显式选择。 */
.tag { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 500; padding: 3.5px 10px; border-radius: 999px; background: var(--ui-band-strong, rgba(17,24,39,.07)); border: 1px solid transparent; color: var(--ui-ink-2); }
.tag[data-variant="outline"] { background: transparent; border-color: var(--ui-line-strong, rgba(17,24,39,.1)); }
.tag[data-variant="primary"] { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.tag[data-variant="success"] { background: #ecfdf3; border-color: transparent; color: #067647; }
.tag[data-variant="warning"] { background: #fffaeb; border-color: transparent; color: #b54708; }
.tag[data-variant="danger"] { background: #fef3f2; border-color: transparent; color: #b42318; }
.tag[data-variant="info"] { background: #eef2f8; border-color: transparent; color: #175cd3; }

/* 引用：浅底划界，不描边 */
.citation { display: flex; gap: 9px; align-items: flex-start; text-decoration: none; color: inherit; border: 0; border-radius: 12px; padding: 11px 13px; background: var(--ui-band, rgba(17,24,39,.035)); transition: background .18s ease; }
.citation:hover { background: var(--ui-band-strong, rgba(17,24,39,.07)); }
.cite-title { font-size: 12.5px; font-weight: 600; }

/* ── 块套块：内层要么去掉底色，要么加深一档 ────────────────────────────────
 * Card 已经是 --ui-band，内层再用同一个值就是「隐形」的 —— 看起来像没有边界。
 * 按内层的性质分两种处理：
 *   内容区（表格 / 代码 / Markdown 长文）→ 去掉底色，只靠内部横线
 *   独立对象（可选项、折叠项、音频、引用、实体卡）→ 加深到 --ui-band-strong
 */
.card :is(.opt-card, .acc-item, .audio, .citation, .entity) {
  background: var(--ui-band-strong, rgba(17,24,39,.07));
}
.card :is(.opt-card:hover, .acc-item.open) { background: rgba(17, 24, 39, .1); }
.card :is(.sheet, .table-wrap, .code-block, .md[data-variant="sunk"]) { background: transparent; }

/* 图片：Image / AsyncImage / Entity / ImageGallery / AsyncImageGroup；加载占位与 Skeleton 共用 shimmer */
.figure { margin: 0; display: flex; flex-direction: column; gap: 6px; }
/* 图片本身有内容，不需要底色划界；只留一条很浅的线收住边缘（③控件层） */
.img { width: 100%; display: block; border-radius: 11px; border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); background: var(--ui-band, rgba(17,24,39,.035)); }
.figure figcaption { font-size: 11.5px; color: var(--ui-ink-3); }
.gallery { display: grid; gap: 8px; }
@keyframes shimmer { from { background-position: 140% 0; } to { background-position: -40% 0; } }

/* 图表：BarChart / LineChart / PieChart（ECharts 底座，见 echarts.js） */
${CHART_CSS}

/* 代码框与语法高亮：CodeBlock / MarkDownRenderer 的代码围栏（见 code.js） */
${CODE_CSS}

/* 输入框：Input / TextArea / Select —— 控件层，用细线交代可输入 */
.input { font: inherit; font-size: 13px; color: var(--text); background: transparent; border: 1px solid var(--ui-line-strong, rgba(17,24,39,.1)); border-radius: 10px; padding: 9px 12px; width: 100%; transition: border-color .16s ease, box-shadow .16s ease; }
.input:hover { border-color: rgba(17, 24, 39, .16); }
.input:focus { outline: none; border-color: var(--accent-line, #ccd8d2); box-shadow: 0 0 0 3px var(--accent-ring, rgba(34,61,54,.14)); }
textarea.input { resize: vertical; }

/* 按钮：Button / IconButton，按钮行：Buttons / Form */
.buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { font: inherit; font-size: 12.5px; font-weight: 600; border-radius: 10px; padding: 9px 16px; cursor: pointer; border: 1px solid transparent; display: inline-flex; align-items: center; gap: 6px; transition: background .18s ease, border-color .18s ease, color .18s ease; }
.btn[data-variant="primary"] { background: var(--accent); color: var(--accent-text); }
.btn[data-variant="primary"]:hover { background: var(--accent-hover); }
.btn[data-variant="secondary"] { background: transparent; color: var(--text); border-color: var(--ui-line-strong, rgba(17,24,39,.1)); }
.btn[data-variant="secondary"]:hover { border-color: rgba(17, 24, 39, .18); background: var(--ui-band, rgba(17,24,39,.035)); }
.btn[data-variant="tertiary"] { background: transparent; color: var(--ui-ink-2); }
.btn[data-variant="danger"] { background: #fef3f2; color: #b42318; border-color: #fee4e2; }
.btn.block { width: 100%; justify-content: center; }
.btn.icon-only { padding: 7px; }

/* 勾选 / 单选 / 开关组：CheckBoxGroup / RadioGroup / SwitchGroup 与它们的条目 */
.opt-group { display: flex; flex-direction: column; gap: 7px; }
.opt { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.opt input { accent-color: var(--accent); width: 15px; height: 15px; }
`;
