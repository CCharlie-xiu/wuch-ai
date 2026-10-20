// ─────────────────────────────────────────────────────────────────────────────
// 组件目录（catalog）
//
// 目录定义了「模型能请求什么」：
//   · 模型从组件里挑、用 OpenUI Lang 组合，而不是写 HTML / CSS
//   · 解析器拿目录当 schema：组件名、位置参数、类型、枚举都从这里来
//   · 渲染器只画目录里的组件，模型输出无法注入任意 markup 或样式
//
// 每个组件一个文件（components/<Name>.js），签名 + 渲染 + 样式写在一起。
// 新增组件：加一个文件，在 components/index.js 里登记一行。其余全部自动派生。
// ─────────────────────────────────────────────────────────────────────────────

import COMPONENT_LIST from './components/index.js';
import { SKILLS } from './skills/index.js';
import { MIN_COL as GRID_MIN_COL, DEFAULT_GAP as GRID_GAP } from './components/Grid.js';
import { TEXT_COLORS } from './tokens.js';

export { TOKENS, TEXT_STYLES, TEXT_COLORS, TEXT_SIZES, TEXT_WEIGHTS, SPACE_TOKENS, MAX_WIDTHS, VARIANTS } from './tokens.js';
export { defineComponent, PARAM_TYPES } from './define.js';
export { BASE_CSS } from './styles.js';
export { evaluateSheet, toCell, parseInput, cellSource, formatValue, parseRef, refName } from './sheet-formula.js';
export { inlineCells } from './components/Sheet.js';

export const COMPONENTS = COMPONENT_LIST;

/** name → 定义 */
export const CATALOG = new Map(COMPONENTS.map((c) => [c.name, c]));
if (CATALOG.size !== COMPONENTS.length) {
  const seen = new Set();
  const dup = COMPONENTS.find((c) => (seen.has(c.name) ? true : (seen.add(c.name), false)));
  throw new Error(`组件 ${dup.name} 重复登记`);
}

/** 流式占位：编译器在还没写到的位置放它，形状取自目标组件的 skeleton */
export const PLACEHOLDER = 'Placeholder';

/** 服务端解析的组件：模型只写描述/引用，值由服务端补 */
export const SERVER_RESOLVED = new Set(COMPONENTS.filter((c) => c.serverResolved).map((c) => c.name));

// ─────────────────────────────────────────────────────────────────────────────
// 技能：组件上的 skill 字段与 skills/ 里的清单必须互相对得上
// ─────────────────────────────────────────────────────────────────────────────
export { SKILLS };
export const SKILL_MAP = new Map(SKILLS.map((s) => [s.id, s]));
for (const s of SKILLS) {
  for (const name of s.components) {
    if (CATALOG.get(name)?.skill !== s.id) throw new Error(`技能 ${s.id} 列出的组件 ${name} 不存在或没有标 skill: '${s.id}'`);
  }
}
for (const c of COMPONENTS) {
  if (c.skill && !SKILL_MAP.get(c.skill)?.components.includes(c.name)) throw new Error(`组件 ${c.name} 标了 skill: '${c.skill}'，但技能清单里没有它`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 组件组：提示词按组下发。基础组常驻，其余由对话路由按这一轮的需要挑。
// 组件按自己的 group 归组，个别组件单独指定；新组件不用登记，跟着 group 走。
// ─────────────────────────────────────────────────────────────────────────────
export const COMPONENT_GROUPS = [
  { id: 'base', name: '基础布局与文字', description: '布局、卡片、标签页、时间线、清单、文字、提示块、按钮', core: true },
  { id: 'charts', name: '图表与指标', description: '柱状 / 折线 / 饼图、函数图像、指标卡、进度条、仪表盘' },
  { id: 'table', name: '表格与实体', description: '数据表格、商品 / 地点卡片' },
  { id: 'forms', name: '表单与交互控件', description: '输入框、下拉、滑块、单选多选、开关、选项卡片' },
  { id: 'media', name: '图片与影音', description: '图片、图集、视频、音频' },
  { id: 'rich', name: '代码、公式与来源', description: '代码块、数学公式、引用来源、图标标签' },
];
const GROUP_BY_CATEGORY = { Layout: 'base', Content: 'base', Feedback: 'base', Meta: 'base', Charts: 'charts', Data: 'table', Forms: 'forms', Media: 'media' };
const GROUP_OVERRIDES = { Buttons: 'base', Button: 'base', CodeBlock: 'rich', Formula: 'rich', Citation: 'rich', Cite: 'rich', Sources: 'rich', IconTag: 'rich', IconText: 'rich' };
export const GROUP_IDS = COMPONENT_GROUPS.map((g) => g.id);

/** 组件属于哪个组 */
export function groupOf(def) {
  return GROUP_OVERRIDES[def.name] || GROUP_BY_CATEGORY[def.group] || 'base';
}

const COMPONENT_RE = new RegExp(`\\b(${COMPONENTS.map((c) => c.name).join('|')})\\s*\\(`, 'g');

/** 一段 OpenUI Lang 里用到了哪些组件组（续画时这些组的说明要留在提示词里） */
export function groupsUsedIn(source) {
  const out = new Set();
  for (const m of String(source || '').matchAll(COMPONENT_RE)) {
    const def = CATALOG.get(m[1]);
    if (def && !def.internal && !def.skill) out.add(groupOf(def));
  }
  return [...out];
}

const SKILL_COMPONENT_RE = new RegExp(`\\b(${COMPONENTS.filter((c) => c.skill).map((c) => c.name).join('|') || '$^'})\\s*\\(`, 'g');

/** 一段 OpenUI Lang 里用到了哪些技能的组件（续画时它们的说明要留在提示词里） */
export function skillsUsedIn(source) {
  const out = new Set();
  for (const m of String(source || '').matchAll(SKILL_COMPONENT_RE)) out.add(CATALOG.get(m[1]).skill);
  return [...out];
}

// ─────────────────────────────────────────────────────────────────────────────
// 签名：给模型看的位置参数说明
// ─────────────────────────────────────────────────────────────────────────────
function typeOf(param) {
  switch (param.type) {
    case 'nodes':
      return 'Node[]';
    case 'node':
      return 'Node';
    case 'array':
      return 'Array';
    case 'space':
      return 'Space';
    case 'enum':
      return param.enum.map((v) => JSON.stringify(v)).join('|');
    default:
      return param.type;
  }
}

export function signature(def) {
  return `${def.name}(${def.params.map((x) => `${x.name}${x.required ? '' : '?'}: ${typeOf(x)}`).join(', ')})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 由目录生成 system prompt —— OpenUI 的「library-driven prompts」
// ─────────────────────────────────────────────────────────────────────────────
// 示例里的列数必须跟着画幅走：写死 `Grid(..., 3)` 时，模型会照抄示例，
// 哪怕「画布与画幅」那段说这块画布能放 4 列。
const exampleFor = (b) => `root = Stack([title, board, actions], "column", "m")
title = TextContent("Q3 销售复盘", "xl-heavy")
board = Grid([m1, m2, m3, sect, revenue, channels, risk], ${b.cols})
m1 = MetricIndicator("营收", "¥4.2M", "+12%", "up")
m2 = MetricIndicator("订单", "18,240", "+6%", "up")
m3 = MetricIndicator("退货率", "2.1%", "-0.4pt", "down")
sect = GridItem([InlineHeader("1 · 营收结构", "线上连涨三个月，线下基本持平")], ${b.cols})
revenue = GridItem([Card([revenueHead, revenueChart])], ${Math.min(2, b.cols)})
revenueHead = CardHeader("月度营收", "单位：万元")
revenueChart = BarChart(["7月", "8月", "9月"], [Series("线上", [120, 138, 152]), Series("线下", [96, 101, 99])])
channels = Card([CardHeader("渠道占比", "Q3"), PieChart([Slice("线上", 61), Slice("线下", 39)], "donut")])
risk = TextCallout("warning", "退货集中", "退货七成来自两个 SKU，建议先查这两款的尺码表。")
actions = Buttons([Button("导出报表", "action:export"), Button("按渠道拆开看", "turn:把 Q3 营收按渠道拆开，给出每个渠道的趋势", "secondary")])
summary = [Note("营收稳步上涨", "Q3 营收 ¥4.2M，同比 +12%，线上三个月连涨。", ["m1", "revenueChart"]), Note("线下持平", "线下渠道 96–101 万之间波动，占比 39%。", ["revenueChart", "channels"])]`;

/** 没带图表组时的示例：只用基础组的组件 */
const baseExampleFor = (b) => `root = Stack([title, board, actions], "column", "m")
title = TextContent("新人入职第一周", "xl-heavy")
board = Grid([sect, plan, tips, faq], ${b.cols})
sect = GridItem([InlineHeader("第一周", "先跑通，再谈产出")], ${b.cols})
plan = GridItem([Card([CardHeader("日程", "周一到周五"), days])], ${Math.min(2, b.cols)})
days = Timeline([TimelineItem("领设备、开通账号", "周一", "done"), TimelineItem("和导师过一遍代码库", "周二", "active"), TimelineItem("提交第一个小改动", "周五", "todo")])
tips = Card([CardHeader("小贴士"), MarkDownRenderer("- 先读 README 和贡献指南\\n- 卡住超过半小时就去问导师")])
faq = Card([CardHeader("常见问题"), Accordion([AccordionItem("vpn", "VPN 连不上？", [TextContent("先确认已加入 IT 群，再重装客户端。")])])])
actions = Buttons([Button("生成第二周计划", "turn:按同样的格式给我第二周的计划")])
summary = [Note("一周节奏", "周一开通、周二熟悉代码、周五交第一个改动。", ["days"]), Note("两个提醒", "先读文档，卡住就问。", ["tips"])]`;

/** 画布尺寸 → 这一版能装多少东西。
 *
 * 以前篇幅是写死的「组件 30 个以内」：760px 窄画布和 1448px 宽画布共用一个上限。
 * 这里改成从画幅推：几列、一屏几块、首屏放什么、最多长几屏。模型拿到的不是
 * 一个孤立数字，而是「这块画布能装多少」。
 *
 * @param {{width?: number, height?: number}|null} viewport 画布可见区域（px）
 */
const MAX_COLS = 4;      // 再多每列就窄于 ~300px，图表和表格都放不下
const WIDE_BREAK = 1280; // 到这个宽度才放开 4 列
const BLOCK_CHROME = 80; // 一块内容里除图表外的标题 / 内边距 / 间距

export function canvasBudget(viewport) {
  const w = Math.round(Number(viewport?.width) || 0);
  const h = Math.round(Number(viewport?.height) || 0);
  const known = w > 0;
  const width = known ? w : 860;
  const height = h > 0 ? h : 720;
  const fit = Math.max(1, Math.floor((width + GRID_GAP) / (GRID_MIN_COL + GRID_GAP)));
  const cols = Math.max(1, Math.min(fit, width >= WIDE_BREAK ? MAX_COLS : 3));
  const colW = Math.max(1, Math.floor((width - GRID_GAP * (cols - 1)) / cols));
  const chartH = Math.max(160, Math.min(300, Math.round(height * 0.3)));
  const rows = Math.max(1, Math.floor(height / (chartH + BLOCK_CHROME)));
  const perScreen = Math.max(2, cols * rows);
  const screens = 2;
  const blocks = perScreen * screens;
  // 一块平均 3 个组件（块容器 + 标题 + 内容）；指标卡算 1 个，表格 / 图算 2–4 个
  const components = Math.max(18, Math.min(64, Math.round(blocks * 3)));
  return { known, width, height, cols, colW, chartH, rows, perScreen, screens, blocks, components };
}

/** 画布尺寸 → 给模型的布局约束：这块画布是瀑布流，一屏能放几块，往下能长多长 */
function layoutSection(budget) {
  const b = budget;
  const cross = b.cols === 1
    ? '只有一列时不要用 GridItem 跨列，内容从上往下排。'
    : `宽内容（表格、折线图、大图）用 \`GridItem([...], 2)\` 跨列，最宽 ${b.cols}。`;
  const scale = b.known
    ? `当前画布宽 ${b.width}px、首屏可见高度约 ${b.height}px。这是一块**从上往下生长的瀑布流画布**，不是固定一屏：`
    : `画布尺寸还没量到，先按 ${b.width}px 宽的标准桌面画布排。它不是固定一屏，是**从上往下生长的瀑布流**：`;
  return `## 画布与画幅

${scale}

- **一个 Grid 铺满整页**：所有内容块都放进同一个 \`Grid\`，页头用 \`Stack([header, board], "column", "m")\` 放在它上面。多包几个 Grid 会让段间距、列基线各不相同，瀑布流就散了。
- **瀑布流**：块按自己的高度往下落，左右列自动咬合（masonry），高矮不齐才对。不要为了对齐凑等高，也不要手动算行、手动分行。
- **分节**：需要「1 · 用量」这种小节标题时，写成跨满整行的一块 \`GridItem([InlineHeader(...)], ${b.cols})\`，让标题也参与瀑布流，而不是用 Stack 另起一段。
- **列数**：这一屏放得下 ${b.cols} 列，每列约 ${b.colW}px，写 \`Grid([...], ${b.cols})\`。${cross}
- **块高先定**：图表 height 一般 ${b.chartH}，窄列里不低于 160，需要细看的大图可以到 ${Math.min(480, b.chartH + 120)}。图片、视频写 aspectRatio（如 "16:9"、"4:3"、竖屏 "9:16"），窄列里优先横图。尺寸在写组件时就定好，别靠内容撑开 —— 界面边写边显示，块大小先定下来才不跳。
- **首屏是黄金区**：约 ${b.rows} 行、${b.perScreen} 块。标题、结论、关键指标、主图全放这一屏，打开就能看到重点。填法：矮块（指标卡）占三到四成，中块（图表）占一半，高块（表格、清单、大图）一两块。
- **往下生长**：默认只画首屏；用户要「详细」「完整」时再往下加，最多 ${b.screens} 屏（约 ${b.blocks} 块）。越往下越少人看，次要内容压成更矮的块，或收进 Tabs / Accordion。
- **一块一件事**：一个块只讲一件事（一组指标、一张图、一张表、一段结论）。不要把整页塞进一张大卡，也不要把同一件事拆成五六张小卡。
- **节奏**：指标块矮、图表块中、表格块高，交错着放才像瀑布；同一种块连放三四个会显得很平。`;
}

/** 多轮续画：模型第一行写 @new / @edit，@edit 时只写改动的语句 */
function canvasSection(canvas) {
  return `## 当前画布（v${canvas.version || '?'}）

用户正在看的界面就是下面这份 OpenUI Lang：

\`\`\`
${canvas.source.trim()}
\`\`\`

## 这一轮：重画还是续画

回答的第一行单独写一个模式指令，第二行起才是 OpenUI Lang：

- \`@edit\`：在当前画布上改。只写新增的和要改的语句，同名变量整行覆盖旧的；要删掉的写 \`变量名 = null\`，并把它从引用它的数组里去掉（那个数组所在的语句也要重写）；没改的语句一个字都不要重写。root 不变就不写 root。最后照常写 summary（覆盖上一轮的总结，只说这一轮改了什么）。
- \`@new\`：用户换了话题或明确要求重做，整份重写，从 root 开始。

用户在调整、补充、修正当前界面 → \`@edit\`；问的是另一件事 → \`@new\`。拿不准时用 \`@edit\`。

改多大跟着用户的话走：
- 小改（换个颜色、改句文案、加一项、删一块）→ 只改涉及的那几条语句，其余布局一律不动。
- 「再详细点」「展开讲讲」→ 在原有结构上加内容块或展开现有块，不推翻已有的布局和结论。
- 只有换了话题、或明确说「重做」「换个思路」时才 \`@new\`。`;
}

function datasetSection(datasets) {
  const blocks = datasets.map((d) => {
    const sheets = (d.sheets || []).map((s) => {
      const head = (s.header || []).map((h, i) => `${colName(i)}=${h}`).join('，');
      const sample = (s.sample || []).map((r) => `  ${JSON.stringify(r)}`).join('\n');
      return `- 工作表「${s.name}」：${s.rows} 行 × ${s.cols} 列（含表头）；表头 ${head || '（空）'}${sample ? `\n  前几行：\n${sample}` : ''}`;
    });
    return `### ${d.id} · ${d.name}\n${sheets.join('\n')}`;
  });
  return `## 数据集

会话里已有这些表格数据（用户导入或编辑过），用 \`Sheet("数据集 id", "工作表名")\` 引用：

${blocks.join('\n\n')}`;
}

/** 0 → A，25 → Z，26 → AA */
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * @param {object} [o]
 * @param {string[]} [o.activeSkills]  用户在输入框里选中的技能：组件说明 + 技能提示词 + 工具都给
 * @param {string[]} [o.usedSkills]    当前画布已经用到的技能：只给组件说明，免得续画时模型不认识画布上的组件
 * @param {{source: string, version?: number}} [o.canvas] 当前画布（HEAD 快照）；有它才讲 @new / @edit
 * @param {object[]} [o.datasets]      会话里的数据集摘要
 * @param {string[]|null} [o.groups]   这一轮要的组件组；基础组总在。null = 全部
 */
export function generatePrompt({ tools = [], activeSkills = [], usedSkills = [], canvas = null, datasets = [], viewport = null, groups = null } = {}) {
  const active = activeSkills.map((id) => SKILL_MAP.get(id)).filter(Boolean);
  const budget = canvasBudget(viewport);
  const visible = new Set([...activeSkills, ...usedSkills]);
  const loaded = groups ? new Set(['base', ...groups]) : new Set(GROUP_IDS);
  const skillTools = active.flatMap((s) => s.tools);
  const allTools = [...tools, ...skillTools.map((t) => (typeof t === 'string' ? t : `\`${t.name}\` — ${t.description}`))];
  const byGroup = new Map();
  for (const c of COMPONENTS) {
    if (c.internal) continue;
    if (c.skill && !visible.has(c.skill)) continue;
    if (!c.skill && !loaded.has(groupOf(c))) continue;
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group).push(c);
  }
  const lines = [];
  for (const [group, items] of byGroup) {
    lines.push(`### ${group}`);
    for (const c of items) lines.push(`- \`${signature(c)}\` — ${c.description}${c.data ? '（数据型，只能写在数组参数里）' : ''}`);
    lines.push('');
  }

  return `你是界面生成模型。你不写 HTML、CSS 或 JavaScript，你用 OpenUI Lang 把下面目录里的组件组合成界面。

## OpenUI Lang

逐行书写，每行一条赋值：\`变量名 = 表达式\`。表达式只有这几种：

- 组件调用 \`Name(参数1, 参数2, ...)\` —— 位置参数，顺序见下方签名
- 数组 \`[a, b, c]\`
- 字符串 \`"…"\`（双引号，换行写 \\n）、数字、\`true\` / \`false\` / \`null\`
- 另一个变量名（引用可以写在定义之前）

没有运算、条件、循环、函数、对象字面量和注释。

## 示例

\`\`\`
${loaded.has('charts') ? exampleFor(budget) : baseExampleFor(budget)}
\`\`\`

## 组合规则

1. 第一行写 \`root = ...\`，先搭骨架，再按从上到下、从外到内的顺序定义被引用的变量。界面按行流式出现：引用了还没写到的变量先显示骨架占位，写到那一行原地替换成成品，所以骨架越早越好。
2. 子组件放进数组：\`Stack([a, b])\`、\`Card([header, body])\`。单个子组件的参数（\`Node\`）直接写组件或变量。
3. **整页只有一个 Grid，它就是瀑布流本体。** 所有内容块（指标、图表、表格、清单、提示、图片）都直接放进这一个 Grid，按阅读顺序排；块会自动落进当前最短的那一列，左右持续咬合。详见「画布与画幅」。
   - 不要按段落各包一个 Grid（"KPI 一个、图表一个、表格一个"）：段与段的间距会变成外层 Stack 的间距，和块间距对不上，列也对不齐，整页立刻不像瀑布流。
   - 需要分节标题时，把标题包成跨满整行的一块：\`GridItem([InlineHeader("1 · 用量", "一句话")], 4)\`（写满列数），它和普通块一起参与瀑布流。
   - 只有页头（大标题 + 一排标签 / 按钮）留在 Grid 外面：\`root = Stack([header, board], "column", "m")\`。
   - 不要用 Stack 在块之间加间距；块与块的间距统一由 Grid 的 gap 决定。需要分组时用 Card 把几块包在一起，不要再套一层 Grid。
4. 可选参数可以省略：实参按类型自动对到后面第一个接得住的参数上。两个相邻参数类型相同（例如两个字符串）时，用 \`null\` 占住不想填的那个。
5. 数据型组件（Series / Slice / Col / SelectItem / Span）只写在对应的数组参数里，例如 \`PieChart([Slice("自然搜索", 34), Slice("付费", 22)])\`。
6. \`Space\` 写 token 名 \`"none" | "s" | "m" | "l" | "xl"\` 或刻度序号 0–9；不要写像素或颜色。
7. 每个变量只定义一次，变量名用英文小驼峰。组件名、参数顺序、枚举取值必须与目录一致，写错的参数会被丢弃。
8. 没有状态和表达式：滑块、输入框、选项卡片等交互在本地生效。需要模型继续时，用按钮 action \`"turn:<下一轮要说的话>"\`，或用表单提交 \`"submit:<表单id>"\`。
9. ${loaded.has('media') ? '图片用 `AsyncImage("画面描述")`，服务端会去取图；不要编 URL。' : '这一轮没有加载图片组件，不要写图片。'}
10. 数据要真实具体：数字、标签、单位都写清楚，不要写"示例数据"。
11. 只输出 OpenUI Lang${canvas && canvas.source ? '（第一行的模式指令除外，见文末「这一轮：重画还是续画」）' : ''}：不要代码围栏，不要解释，不要 Markdown 散文。需要成段文字时用 TextContent / RichText / MarkDownRenderer / Callout。
    文字强调：整段换颜色 / 字号 / 粗细用 TextContent 的 color / size / weight，如 \`TextContent("¥1,280", "primary", "2xl", "bold")\`；一句话里只强调几个字用 RichText + Span，如 \`RichText(["月费 ", Span("¥1,280", "primary", "bold"), "，比上月 ", Span("+12%", "success")])\`。颜色只用 ${TEXT_COLORS.join(' / ')}，用来表达含义（涨跌、风险、重点），不要为了好看给每段上色。
12. 最后一行写 \`summary = [Note("标题", "一两句话", ["变量名"]), ...]\`：2–4 条会话总结，显示在右侧对话里，不进界面。第三个参数写这条总结说的是界面里哪些变量（字符串），用户点它会定位到对应组件。
13. 篇幅按画幅算，不凭感觉：默认只画首屏（块数见「画布与画幅」），整份脚本 ${budget.components} 个组件以内、嵌套不超过 4 层。回答一个问题时只画回答它所需的那几块，不要顺手铺成全景报告。用户明确要「详细」「完整」时再往下长，但仍优先压进 Tabs / Accordion，而不是一路往下堆。

${layoutSection(budget)}

## 可用组件（\`?\` 表示可选）

${lines.join('\n')}${active.length ? `\n${active.map((s) => s.prompt).join('\n\n')}\n` : ''}${datasets.length && visible.has('sheet') ? `\n${datasetSection(datasets)}\n` : ''}${allTools.length ? `\n## 可用工具\n\n${allTools.map((t) => `- ${t}`).join('\n')}\n` : ''}${canvas && canvas.source && canvas.source.trim() ? `\n${canvasSection(canvas)}\n` : ''}`;
}
