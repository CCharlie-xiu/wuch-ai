# wuch-ai · UI 设计规范

> 状态：**草案 v0.1** · 只有规范，不含实现改动
> 适用范围：`apps/web`（壳层）· `packages/catalog`（模型生成内容）
> 关联：`DESIGN.md`（架构与数据层）· `DESIGN-KB.md`（知识库）
> 立论依据：对 `apps/web/css/app.css` 的静态统计 + 1920×1080 实机渲染测量

---

## 0. 一页速览

| 决策 | 结论 |
|---|---|
| 视觉模型 | **双表面一个系统**：Canvas（冷白）与 Chrome（纯白卡面）共用一套 token，只靠明度和 1px 线区分 |
| 字体 | **UI 与编辑声部分家**：壳层与数据用系统无衬线，霞鹜文楷只做品牌 / 首屏 / 助手正文；字重只有 400 |
| 字重 | 只用真实存在的字重；**禁止伪粗体** |
| 主色 | **深松绿 `#223D36`**。主按钮松绿底白字；链接亮一档 `#2B5548` |
| 色板 | 64 个硬编码 hex 收敛为 20 个语义色 + 10 级冷中性；**删除一切米黄 / 橄榄 / 铁锈** |
| 字阶 | 15 档 → 8 档（11 / 12 / 13 / 14 / 16 / 20 / 32 / 48） |
| 圆角 | 15 档 → 5 档（4 / 8 / 12 / 16 / 999） |
| 阴影 | 5+ 套 → 4 级（e0–e3），主按钮取消渐变、内发光与文字阴影 |
| 动效 | 8 时长 / 6 曲线 → 4 时长 / 2 曲线 |
| 每屏主行动 | 有且只有一个 |
| 空态 | 不承载营销内容 |

---

## 1. 设计定位

### 1.1 一句话

> **安静的画布，正在生长的界面。**
> 界面是画框，模型生成的内容才是画。画框永远比画低一级：更小、更灰、更少阴影。

### 1.2 双表面模型

> **方向修订（v0.2）**：初版用「暖纸 + 大地色」表达编辑感，实测是误判 ——
> 米黄底会把楷体压成「旧书」，而且和 Indigo 工具外壳互相打架。
> 现在两个表面都去彩，只差一点点冷暖和明度。高级感来自**冷白、纯墨、细线、留白**，
> 不来自颜色发黄。

系统只有两个表面，不是两套主题：

| 表面 | Token | 底色 | 用在哪 | 特征 |
|---|---|---|---|---|
| **Canvas · 画布** | `--surface-canvas` | `#fafbfc` | 画布区、首屏、空态、生成内容的底 | 极浅冷白、无边界、无阴影 |
| **Chrome · 卡面** | `--surface-card` | `#ffffff` | 顶栏、聊天卡、卡片、输入、弹层 | 纯白、1px 冷灰边、最多 e2 |

- 两表面**共用同一套文字色、同一套状态色、同一套圆角与间距**；
- 区分只靠 `background` + `border` + `elevation`，**不靠换字体、不靠换色系**；
- 聊天卡是纯白卡浮在浅冷白画布上 → 只靠明度差分层，**不要三层阴影**；
- 生成内容落在白卡上，白卡落在画布上 → 三级层次靠明度与 1px 线，不靠阴影。

### 1.3 三条原则

1. **画布是主角，界面是画框。** chrome 的字号、颜色、阴影都不得高于内容。
2. **冷白 + 纯墨，一点松绿。** 中性不带黄；主色只给操作；彩色一屏最多一处。
3. **字重不撒谎，层级不靠猜。** 不用伪粗体；每一级差异都能说出理由。

### 1.4 视觉隐喻的边界

| 可以 | 不可以 |
|---|---|
| 冷白底、楷体大标题、大量留白 | 把杂志排版搬进设置页和表格 |
| 楷体写品牌、首屏、助手正文 | 用楷体渲染数据表、指标数字、代码 |
| 深松绿做强调（一屏一处） | 松绿同时当 success（会和状态色撞语义） |
| 首屏做品牌表达 | 首屏同时放海报、引导卡、广告卡 |

### 1.5 「纸感」的四个来源（明确禁止）

| 来源 | 具体表现 | 处置 |
|---|---|---|
| 米黄 / 羊皮纸底 | `#f3eee6`、`#faf8f4`、`#ece6dc` | 全部删除，换冷白 |
| 做旧水印与大字号底纹 | `OPENUI` 340px 水印 | 删除 |
| 大地色系 | 橄榄 `#4f5d3c`、铁锈 `#b4532f`、褐 `#5b544c` | 删除，只留松绿做强调 |
| 仿古衬线叠加 | Didot 大标题 + 宋体副标 + 文楷三层混排 | 只保留楷体一层 |

---

## 2. Design Tokens

### 2.1 命名规则

三层，只允许上层引用下层：

```
primitive（物理值）      ink-900 / ink-600 / pine-700
      ↓
semantic（语义角色）     text-secondary / surface-canvas / status-warning-fg
      ↓
component（组件局部）    btn-primary-bg / menu-shadow
```

规则：

- 组件里**只准**用 semantic 或 component token，不准写 hex；
- primitive 只出现在 token 定义处；
- 语义名回答「用在哪」，不回答「是什么颜色」；
- 一个 token 至少被两处使用才配存在，否则留在组件里。

### 2.2 色彩

#### 2.2.1 Primitive · 冷中性 Ink

替代原来的冷灰 `#f7f7f8 / #e5e7eb / #9ca3af`。白偏一点点冷，墨是纯墨。

| Token | Hex | 说明 |
|---|---|---|
| `ink-0` | `#ffffff` | 卡片、输入框、聊天卡 |
| `ink-25` | `#fafbfc` | 画布 / 页面底 |
| `ink-50` | `#f4f5f6` | 沉底、hover 底 |
| `ink-100` | `#eef0f2` | active、选中行 |
| `ink-200` | `#e6e8eb` | 分隔线、默认边框 |
| `ink-300` | `#d8dce1` | 强边框、hover 边框 |
| `ink-400` | `#a6adb8` | 禁用前景（对比度豁免） |
| `ink-600` | `#646b75` | 三级文字（5.16:1 on 画布） |
| `ink-700` | `#4c525b` | 二级文字（7.55:1） |
| `ink-900` | `#17191d` | 一级文字 / 墨（16.9:1） |

#### 2.2.2 Primitive · 强调

| Token | Hex | 用途 |
|---|---|---|
| `pine-900` | `#223d36` | 主操作（按钮实底）、选中文字 |
| `pine-800` | `#16281f` | 主操作 hover |
| `pine-700` | `#2b5548` | 链接、首屏 em、引用闪烁 |
| `sage-600` | `#1f6b3f` | success（比主色亮、带一点黄，靠底色调开） |
| `clay-600` | `#8a5a12` | warning |
| `brick-600` | `#b3261e` | danger |

> 主色是**深松绿**：饱和度压到极低，远看是「深色」，近看才认得出是绿。
> 比纯黑有温度，和楷体的墨色最合得来；配白字 11.7:1。
> 全站只有这一个色相，success 靠浅底与更亮的绿区分。

#### 2.2.3 Semantic · 角色

| 语义 token | 引用 | 用途 |
|---|---|---|
| `--surface-canvas` | `ink-25` | 画布底 |
| `--surface-page` | `ink-0` | chrome 底 |
| `--surface-card` | `ink-0` | 卡片 / 输入 / 弹层 |
| `--surface-sunken` | `ink-50` | 代码块、面板、沉底 |
| `--surface-hover` | `ink-50` | 行 hover |
| `--surface-active` | `ink-100` | 行 active / 按下 |
| `--line` | `ink-200` | 默认边框 |
| `--line-soft` | `ink-100` | 内部分隔 |
| `--line-strong` | `ink-300` | hover 边框、强分隔 |
| `--text-primary` | `ink-900` | 标题、正文 |
| `--text-secondary` | `ink-700` | 次要正文 |
| `--text-tertiary` | `ink-600` | 说明、时间、计数 |
| `--text-placeholder` | `ink-600` | 占位符（4.6:1，可与三级同值） |
| `--text-disabled` | `ink-400` | 禁用（豁免） |
| `--text-on-accent` | `ink-0` | 主按钮文字 |
| `--accent` | `pine-900` | 主操作 |
| `--accent-hover` | `pine-800` | 主操作 hover |
| `--accent-soft` | `#edf2f0` | 选中底（偏一点点绿） |
| `--accent-line` | `#ccd8d2` | 选中边框 |
| `--accent-ring` | `rgba(34,61,54,.14)` | 焦点环 |

#### 2.2.4 Semantic · 状态

状态色**必须**成对提供 fg / bg / line，且全部降饱和 —— 不用 Tailwind 原色。

| 角色 | fg | bg | line | fg/bg 对比度 |
|---|---|---|---|---|
| success | `#1f6b3f` | `#eef5f1` | `#cfe0d6` | 5.1 |
| warning | `#8a5a12` | `#faf3e6` | `#e8d8b8` | 4.8 |
| danger | `#b3261e` | `#fbf0ef` | `#f0cfcc` | 5.3 |
| info | `#2f4c7a` | `#eef2f8` | `#ccd8e8` | 6.4 |

> 这四个色是**系统状态**，不是装饰。首屏的强调请用松绿，不要借 warning / danger。

#### 2.2.5 数据可视化

固定顺序取色（`packages/catalog/src/palette.js` 的 `PALETTE`）：

| # | Hex | 名称 |
|---|---|---|
| 1 | `#1d2430` | 墨 |
| 2 | `#3f5d7d` | 藏青 |
| 3 | `#5f7d6e` | 灰绿 |
| 4 | `#8a6f52` | 赭石 |
| 5 | `#6f6a86` | 灰紫 |
| 6 | `#a9b4c0` | 雾灰 |

规则：

- 低饱和、明度有梯度、色相分散：能区分，但不把冷白底打成调色盘；
- 面积图 / 折线只用前 3 色，超过 3 个系列改用「其他」聚合；
- 图表文字 `INK.dim = #697079`，网格线 `INK.grid = #f4f5f6`；
- 由好到差的色带（RAMP）：`#3f7a5c → #6f8f5c → #a08b45 → #a5714a → #a34f45`。

#### 2.2.6 使用配比

| 层级 | 占比 | 内容 |
|---|---|---|
| 中性 | ~95% | 底色、文字、边框 |
| 松绿（主操作） | ~4% | 主按钮、选中、焦点 |
| 松绿亮档（强调） | ≤1% | 链接、首屏一处 em |

> 和初版相比，彩色占比从 15% 压到 5% 以内。这是「高级感」最直接的来源。

### 2.3 字体

#### 2.3.1 字体家族

| Token | 值 | 用在哪 |
|---|---|---|
| `--font-ui` | `-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif` | 壳层、表单、表格、图表、数据 |
| `--font-editorial` | `"LXGW WenKai Screen", "Songti SC", serif` | 品牌字、首屏、助手正文、空态 |
| `--font-serif` | `"Didot", "Bodoni 72", "Playfair Display", "Songti SC", serif` | 仅 `display-xl` 首屏 |
| `--font-mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace` | 代码、ID、hex、调试输出 |

**这是本规范最重要的改动。**
现在的做法是「一个文楷走天下」，导致数据表、指标数字、错误码全用楷体，同时因为字体包只有 400 字重，所有粗体都是浏览器合成。

#### 2.3.2 字阶

| Token | Size / Line | 字重 | 字距 | 用途 |
|---|---|---|---|---|
| `display-xl` | 48 / 1.05 | 400 | -0.02em | 首屏海报（serif） |
| `display-l` | 32 / 1.15 | 400 | -0.01em | 页面级大标题 |
| `title` | 20 / 1.35 | 600 | -0.01em | 区块标题 |
| `subtitle` | 16 / 1.45 | 600 | 0 | 卡片 / 弹层标题 |
| `body` | 14 / 1.70 | 400 | 0 | 正文、生成内容基线 |
| `body-sm` | 13 / 1.65 | 400 | 0 | 聊天、表单、按钮 |
| `meta` | 12 / 1.50 | 400 | 0 | 次要说明、时间 |
| `caption` | 11 / 1.40 | 500 | 0.04em | 仅全大写拉丁 / 数字 |

硬规则：

- **不使用 10、10.5、11.5、12.5、13.5、14.5、15、15.5、17、18、24 这些中间档**；
- 正文不得小于 12px；11px 只用于拉丁大写与数字；
- 数字统一 `font-variant-numeric: tabular-nums`；
- 中文正文行高不得小于 1.6。

#### 2.3.3 字重规则

| 允许 | 条件 |
|---|---|
| 400 | 任何字体 |
| 600 | **仅当字体文件真实提供 600** |
| 700 | 仅 `display-l` 以上的衬线标题 |

- **禁止 500 / 550 / 650 / 680 / 800**：字体包不提供就会触发合成加粗（faux bold），中文楷体在 11–13px 会糊成一团；
- 若坚持全站文楷，则**只准 400**，层级全部交给 `size + color + space`，并把最小字号提到 12px；
- 需要「真粗」时，换 `--font-ui`，不换字重。

**唯一例外（已在代码里落地）**：`body` 默认 `font-synthesis-weight: none`，编辑声部里只有 assistant 正文的 `strong / b / h3–h6` 显式放开合成字重（`.reply-text`）。理由：行内语义强调必须可见，而文楷没有 600；这个例外是局部的、有语义的，和「整站用假粗体撑层级」不是一回事。壳层任何元素都不得放开。

#### 2.3.4 中英混排与数字

- 中文与拉丁之间保留 1/4 空格，不手动加全角空格；
- 英文只用于品牌名、术语、代码；禁止中英夹半句；
- 货币：`¥412,000`；百分比：`+6.2%`；区间：`10:00–12:00`（en dash）；
- 单位与数字之间不加空格（中文语境），代码里遵守语言习惯。

### 2.4 间距

4px 基。全站只允许以下值：

`0 · 2 · 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64`

| Token | px | 典型用途 |
|---|---|---|
| `space-0` | 0 | 重置 |
| `space-05` | 2 | 图标内微调 |
| `space-1` | 4 | 图标与文字 |
| `space-2` | 8 | 控件内 |
| `space-3` | 12 | 组件内边距 |
| `space-4` | 16 | 卡片内边距 |
| `space-5` | 20 | 区块间距 |
| `space-6` | 24 | 面板内边距 |
| `space-8` | 32 | 区块分隔 |
| `space-10` | 40 | 设置页上边距 |
| `space-12` | 48 | 页面级留白 |
| `space-16` | 64 | 首屏 |

> `packages/catalog/src/tokens.js` 已有 `[0,4,8,12,16,20,24,32,40,48]`，直接提升为全站 CSS 变量即可，不要在 `app.css` 里继续手写 7px / 9px / 13px / 22px。

### 2.5 圆角

| Token | px | 用在哪 |
|---|---|---|
| `radius-xs` | 4 | 徽章、勾选框、代码内联 |
| `radius-sm` | 8 | 输入框、按钮、菜单项 |
| `radius-md` | 12 | 卡片、菜单、提示卡 |
| `radius-lg` | 16 | 浮层、聊天卡 |
| `radius-md` | 12 | composer 输入填充区 |
| `radius-pill` | 999 | 胶囊、开关、头像 |

规则：

- 只留 5 档，删除 6 / 7 / 9 / 10 / 14 / 18；
- 同一容器内嵌套时，子元素圆角 = 父圆角 − 内边距，不得出现「卡片 12、内块 10」这种近似值；
- 气泡的单角变体（`16 16 4 16`）属于组件内部规则，不进 token 表。

### 2.6 高度（阴影）

| Token | 值 | 用途 |
|---|---|---|
| `e0` | 无 | 默认：靠**三层边界**分层（见 2.6.1），不用阴影也不用描边 |
| `e1` | `0 1px 2px rgba(30,27,24,.06)` | 主按钮 |
| `e2` | `0 4px 12px -2px rgba(30,27,24,.10)` | 菜单、浮层、toast |
| `e3` | `0 16px 40px -12px rgba(30,27,24,.18)` | 仅模态 |

#### 2.6.1 三层边界

以前所有边界都是同一种 1px 线：卡片外框、表格外框、单元格网格、指标卡外框，粗细深浅完全一样。
眼睛分不出「这是一块」和「这是块里的两行」，整页就散。**去卡片化不等于取消边界，而是按「离眼睛多近」分三层，每层只用一种手段。**

| 层 | 手段 | token | 用在哪 |
|---|---|---|---|
| ① 块 | 极浅底色，无描边 | `--ui-band` = `rgba(17,24,39,.035)` | Card、Table、Sheet、Audio、CodeBlock、折叠项、引用、提示框、骨架占位 |
| ① 块（深一档） | 更深底色 | `--ui-band-strong` = `.07` | 表头、展开项、sunk 卡、胶囊标签、进度轨道、选中态 |
| ② 块内 | 发丝线 | `--ui-line` = `rgba(17,24,39,.06)` | 行之间、表头下方、代码框标题栏、分隔线、引用块左条 |
| ③ 控件 | 细线 | `--ui-line-strong` = `rgba(17,24,39,.1)` | 按钮、输入框、胶囊、开关、勾选框、滑块拇指、白底图片 / 画布 / 地图 |

为什么控件要单独一层：它们本身就比背景亮一档（白底、白胶囊），底色差用不上，只能靠一条线交代「这里可以点」。但线要比中层更细更浅，不能和中层分隔线抢。

规则：

- **块级元素不描边**，一个容器只允许一种边界手段（底色或线，不能都给）；
- 卡片里再放表格 / 代码框时，内层不再自绘外框（`.card .sheet`、`.card .code-block`、`.card .table-wrap` 已置空），否则就是双层边界；
- 块套块：内层如果也是「块」，要么去掉底色（内容区），要么加深一档（独立对象），否则会隐形；
- 指标（`MetricIndicator`）是**数据不是容器**：无底色、无描边，只靠字号与对齐分层。数值 32/650、标签 11.5/500 灰；
- 三级文字 `--ui-ink-3` 压到 `#79828f`（4.3:1）。`#98a1b0` 只有 2.7:1，标签和轴刻度会「看不清」；
- 圆角：Card 用 14，不用全局的 20 —— 20 看起来像一张卡片，14 更像一块区域；
- 组件一律不引用宿主的 `--border` / `--border-soft`（那是壳层的线），只用自己的三层 token；
- 回归保护：`bun run test:catalog` 的 `boundaries.test.js` 会静态扫描所有组件 CSS，出现 `--border` 或块级元素描边就失败。

- 同一屏幕最多出现两级高度；
- 禁止为「好看」叠加多层阴影。

### 2.7 动效

| Token | 时长 | 用途 |
|---|---|---|
| `motion-fast` | 120ms | hover、按下、颜色 |
| `motion-base` | 200ms | 菜单、提示、展开 |
| `motion-surface` | 280ms | 面板、抽屉、收起 |
| `motion-page` | 400ms | 路由 / View Transition |

| Token | 曲线 |
|---|---|
| `ease-standard` | `cubic-bezier(.22, 1, .36, 1)` |
| `ease-exit` | `cubic-bezier(.4, 0, 1, 1)` |

规则：

- 全站只保留这两条曲线；现有 `.2,.8,.2,1` / `.25,.1,.25,1` / `.55,0,1,.45` 等全部归并；
- 只动 `transform` 与 `opacity`，不动 `width/height/margin`（现有 `pane` 用 `margin-right` 过渡，属于布局抖动）；
- `@media (prefers-reduced-motion: reduce)` 下时长归 0，保留状态变化；
- 流式 shimmer 属于「进行中」语义，不算装饰动效。

### 2.8 图标

| 规格 | 值 |
|---|---|
| 画布 | 24 × 24 |
| 描边 | 1.7 |
| 线帽 / 连接 | round |
| 尺寸 | 14 / 16 / 20 / 24 四档 |
| 颜色 | 继承 `currentColor` |

规则：

- 删除 1.6 / 1.8 / 1.9 / 2 的散落描边；
- 图标按钮内图标统一 16，工具栏 16，页签 14；
- 只有状态点允许实心；
- 图标必须有 `aria-label` 或可见文字，不得只靠图形表达语义。

### 2.9 层级

| Token | z-index | 用途 |
|---|---|---|
| `z-base` | 0 | 文档流 |
| `z-sticky` | 10 | 吸顶栏 |
| `z-dropdown` | 100 | 菜单、选择器 |
| `z-overlay` | 200 | 遮罩、预览 |
| `z-modal` | 300 | 对话框 |
| `z-toast` | 400 | toast |
| `z-tooltip` | 500 | 提示 |

现有 5 / 19 / 20 / 40 / 60 / 90 / 99 / 1000 全部替换。

### 2.10 CSS 变量草案

```css
:root {
  /* primitive · ink（冷中性） */
  --ink-0:#ffffff; --ink-25:#fafbfc; --ink-50:#f4f5f6; --ink-100:#eef0f2;
  --ink-200:#e6e8eb; --ink-300:#d8dce1; --ink-400:#a6adb8;
  --ink-600:#646b75; --ink-700:#4c525b; --ink-900:#17191d;

  /* primitive · accent */
  --pine-900:#223d36; --pine-800:#16281f; --pine-700:#2b5548;
  --sage-600:#1f6b3f; --clay-600:#8a5a12; --brick-600:#b3261e;

  /* semantic · surface */
  --surface-canvas:var(--ink-25); --surface-page:var(--ink-0);
  --surface-card:var(--ink-0); --surface-sunken:var(--ink-50);
  --surface-hover:var(--ink-50); --surface-active:var(--ink-100);

  /* semantic · line */
  --line:var(--ink-200); --line-soft:var(--ink-100); --line-strong:var(--ink-300);

  /* semantic · text */
  --text-primary:var(--ink-900); --text-secondary:var(--ink-700);
  --text-tertiary:var(--ink-600); --text-placeholder:var(--ink-600);
  --text-disabled:var(--ink-400);

  /* semantic · accent */
  --accent:var(--pine-900); --accent-hover:var(--pine-800);
  --accent-soft:#edf2f0; --accent-line:#ccd8d2;
  --accent-ring:rgba(34,61,54,.14); --text-on-accent:var(--ink-0);
  --link:var(--pine-700);

  /* semantic · status */
  --success-fg:#1f6b3f; --success-bg:#eef5f1; --success-line:#cfe0d6;
  --warning-fg:#8a5a12; --warning-bg:#faf3e6; --warning-line:#e8d8b8;
  --danger-fg:#b3261e;  --danger-bg:#fbf0ef;  --danger-line:#f0cfcc;
  --info-fg:#2f4c7a;    --info-bg:#eef2f8;    --info-line:#ccd8e8;

  /* type */
  --font-ui:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  --font-editorial:"LXGW WenKai Screen","Songti SC",serif;
  --font-serif:"Didot","Bodoni 72","Playfair Display","Times New Roman","Songti SC",serif;
  --font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;

  /* space */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
  --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px;
  --space-12:48px; --space-16:64px;

  /* radius */
  --radius-xs:4px; --radius-sm:8px; --radius-md:12px; --radius-lg:16px; --radius-pill:999px;

  /* elevation */
  --e1:0 1px 2px rgba(16,20,26,.08);
  --e2:0 4px 12px -2px rgba(16,20,26,.10);
  --e3:0 16px 40px -12px rgba(16,20,26,.18);

  /* motion */
  --motion-fast:120ms; --motion-base:200ms; --motion-surface:280ms; --motion-page:400ms;
  --ease-standard:cubic-bezier(.22,1,.36,1); --ease-exit:cubic-bezier(.4,0,1,1);

  /* layout */
  --layout-topbar:52px; --layout-toolbar:44px; --layout-foot:40px;
  --layout-chat:400px; --layout-nav:220px; --layout-gutter:24px;
}
```

## 3. 布局

### 3.1 全局框架

```
┌──────────────────────────────────────────────────────────┐
│ topbar 52                                                │  chrome
├──────────────────────────────────────────────────────────┤
│ toolbar 44                                               │  chrome
├───────────────────────────────────────┬──────────────────┤
│                                       │                  │
│  Canvas 冷白                           │  Chat 纯白卡      │  canvas + chrome
│  padding 24                           │  radius 16       │
│                                       │  e0 + 1px border │
├───────────────────────────────────────┴──────────────────┤
│ foot 40（设置 + HUD）                                     │  chrome
└──────────────────────────────────────────────────────────┘
```

### 3.2 尺寸与断点

| 项 | 值 |
|---|---|
| 顶栏 | 52（保留） |
| 工具栏 | 44（保留） |
| 底栏 | 40 |
| 聊天卡宽 | 400 默认；可拖 360–560 |
| 聊天卡外边距 | 12 |
| 设置左导航 | 220 |
| 设置内容宽 | **640 统一**（现在 560 / 880 两套） |
| 画布内边距 | 24；≥1600 时 32 |

| 断点 | 行为 |
|---|---|
| ≥1600 | 画布 ≥1100，聊天 400 |
| 1280–1599 | 默认 |
| 1024–1279 | 画布让位，工具栏折叠为图标 |
| <1024 | 聊天覆盖画布；收起后显示画布；**必须有明显的展开入口** |

### 3.3 画布区

- 画布**不再有第三层头**：`canvas-title` 与状态徽章合并进工具栏右侧，或只在有内容时出现；
- 空态（hero）与生成内容互斥，不允许同时占位；
- 画布背景 `--surface-canvas`，生成内容一律落在 `--surface-card` 白卡上；
- 缩放/适配/重载/全屏四个按钮保留，但与页签之间加一条 1px 分隔，避免 7 个页签 + 6 个按钮挤成一条。

### 3.4 聊天区

- 白卡 + 1px `--line` + `e0`，**去掉三层阴影**；
- 头部只保留「标题 + 历史 + 新会话 + 收起」；「复制 Markdown」「说明」收进 `⋯` 菜单；
- composer 是唯一主行动区，且**不与聊天卡嵌套**：上方一条通栏 1px 分隔线，下面依次是元信息行（状态点 + 当前轮模式 + 思考强度）、填充式输入区、免责文案；
- 输入区用 `--panel-2` 填充划范围，**不描边**（卡片里再描一个框会出现两条平行圆角）；聚焦时才出现一次 1px `--accent-line` + 4px ring；
- 区内工具一律用**无边框小字 / 图标**，不给胶囊：`+`（28px 幽灵按钮）｜技能 chip｜模型名｜发送（28px 主色圆 + 单箭头）。快捷键放 title，不写进按钮；
- 底栏控件统一 28px 高、同一基线，横向间距只取 2 / 6 两档，避免高矮不齐造成的“错位感”；
- 「全部来源」留在 composer，但降级为同款无边框小字；筛过来源时文字提亮、箭头变主色；
- token 用量**常驻**（只读小字，无边框、无底色）；只在没配模型时隐藏，≥80% 转 warn 色；
- 发送键在生成中变成停止方块，靠 `.is-stop` 切图标，不再重写 innerHTML。

### 3.5 设置页

- 三层结构：**分节（`.set-section`）→ 分组卡（`.set-card`）→ 设置行（`.set-row`）**；
  卡与卡之间 26px，组内行与行只隔一条 1px 内缩线，不再用空白切分；
- 内容列 720 居中；数据密集的分节加 `data-cols="2"`，≥1440 走均衡多列（`break-inside: avoid`），
  新加分组时两栏高度自动配平，不会越加越空；
- 行高 52（12 上下 + 28 控件），标签 13/正文 11.5，说明最多一行，长解释进 `?` 气泡或
  `<details class="set-more">` 折叠；
- 开关统一 `.switch`（36×21），开关永远在行尾；勾选型多选列表（会话排除）才用复选框；
- 控件统一 30px 高 / 8px 圆角：`.set-btn` / `.set-input` / `.tool-approval`；
  行内小操作（显示、确认、改地址）用 `.set-btn.tiny`（24px）；
- 左栏 232，选中项是白卡浮在 `--panel` 上（无边框、无彩色），不把导航读成按钮；
  ≤1100 收窄到 196，≤760 变成顶部横向标签。

### 3.6 登录路由（`/login`）

- **是路由不是浮层**：`login.html` 是独立文档，挂在 `/login`（服务端精确路由）。
  未登录访问 `/` 时，`index.html` 头部内联门禁脚本 `location.replace` 过去，
  带 `?next=` 保留原地址；登录成功再整页跳回。不要在聊天页上盖一层登录弹窗。
- 页内「登录 / 注册」只改 query（`?mode=signup`），用 `pushState` + `popstate`，
  刷新、前进后退、直接粘贴链接都落在同一个状态。`?add=1` 是「添加账号」，
  登录后回到 `next`，账号写进本地列表。
- 构图：三栏 = 208 竖排宣言 / 1fr 品牌舞台 / 392 登录栏，1px 线分隔，整页 100dvh。
  中央是 blob logo + 品牌名，**竖着排列**；四角是 slogan、LOCAL FIRST、页脚信息。
  品牌名走 `--font-editorial`，`clamp(46px, 6.1vw, 92px)`，`®` 用 `.stage-reg`。
- 登录栏在网格里，不是 absolute 覆盖：输入框用下划线（`.auth-field`），
  按钮 42px，第三方登录 40px，已有账号是横向滚动的胶囊（`.auth-chip`）。
- 断点：≤1240 收窄两栏；≤1080 隐藏左栏；≤900 变单列（封面在上、表单在下，可滚动）；
  ≤520 缩字号与内边距；`max-height: 900` 时收一档间距，保证 1280×800 一屏放完。
- 账号数据在 `src/accounts.js`（localStorage mock），页面和菜单只依赖这一层的四个动作：
  登录 / 切号 / 改名 / 退出。接真后端时替换该文件即可。
- 顶栏账号入口 `.account-btn` 不放头像，只显示名字 + 状态点；菜单是 popover
  （`.account-menu`），改名字在菜单内联完成，添加账号与退出走路由。

---

## 4. 组件规范

### 4.0 状态矩阵总表

| 组件 | default | hover | active | focus-visible | disabled | loading | error | selected |
|---|---|---|---|---|---|---|---|---|
| Button | ● | ● | ● | ● | ● | ● | ○ | — |
| IconButton | ● | ● | ● | ● | ● | ○ | — | ● |
| Input | ● | — | — | ● | ● | — | ● | — |
| Tabs | ● | ● | — | ● | ● | — | — | ● |
| MenuItem | ● | ● | — | ● | ● | — | — | ● |
| Toast | ● | — | — | — | — | — | ● | — |
| Dialog | ● | — | — | ● | — | ● | — | — |
| Badge | ● | — | — | — | — | — | ● | — |

`●` 必须有规范 · `○` 允许出现但非必须 · `—` 不适用

### 4.1 Button

| 属性 | sm | md | lg |
|---|---|---|---|
| 高度 | 28 | 32 | 36 |
| 左右内边距 | 10 | 14 | 18 |
| 字号 | 12 / 600 | 13 / 600 | 14 / 600 |
| 圆角 | 8 | 8 | 8 |
| 图标 | 14 | 16 | 16 |

变体：

| 变体 | 底 | 字 | 边框 | 阴影 |
|---|---|---|---|---|
| primary | `--accent` | `--text-on-accent` | 无 | `e1` |
| secondary | `--surface-card` | `--text-primary` | `--line` | `e0` |
| ghost | 透明 | `--text-secondary` | 无 | `e0` |
| danger | `--danger-bg` | `--danger-fg` | `--danger-line` | `e0` |

状态：

- hover：primary `--accent-hover`；其余 `--surface-hover`
- active：`transform: translateY(1px)`，不缩放
- focus-visible：`box-shadow: 0 0 0 3px var(--accent-ring)` + 1px `--accent`
- disabled：`--surface-sunken` 底 + `--text-disabled` 字 + 无阴影
- loading：左侧 14px 旋转环，文字变 `处理中…`，宽度锁定不跳动

禁止：渐变底、文字阴影、多层 inset、把快捷键键帽画成按钮。

### 4.2 IconButton

- 尺寸 28 / 32；圆角 8；图标 16；
- 默认 `--text-tertiary`，hover `--text-primary` + `--surface-hover`；
- 选中：`--accent-soft` + `--accent-line`；
- **必须始终可见**；列表内的次要操作允许降到 60% 不透明度，但不得为 0；
- 必须有 `aria-label` 与 tooltip（tooltip 只补充，不替代 label）。

### 4.3 Input / Textarea

| 项 | 值 |
|---|---|
| 高度 | 34 |
| 内边距 | 0 12 |
| 圆角 | 8 |
| 边框 | 1px `--line` |
| 字号 | 13 |
| placeholder | `--text-placeholder`（4.60:1） |

- focus：边框 `--accent` + `0 0 0 3px --accent-ring`，**不要整块变蓝**；
- error：边框 `--danger-fg` + 下方 12px 错误文案，不用红色底；
- disabled：`--surface-sunken` + `--text-disabled`；
- **composer 是唯一例外：不描边，用填充划范围。** 它本来就嵌在「白底 + 1px 边框 + 16 圆角」的聊天卡里，再描一道边框就会在底部出现两条平行圆角，看上去像圆角画歪了；
  - 常态：`--panel-2` 填充、圆角 12、内边距 12/10，无边框；
  - 与消息区之间只用一条通栏 1px `--line` 分隔（通到卡片边缘，不做内缩）；
  - focus：底色提到纯白 + `0 0 0 1px --accent-line` + `0 0 0 4px --accent-ring`，实线只在聚焦时出现一次；
  - 底栏所有控件统一 28px 高、同一基线，间距只取 2 / 6 两档；
- **不再使用底部铺开细线**：聚焦反馈只靠底色与 ring，输入框内部不要再叠装饰。

### 4.4 Pill / Chip / Badge / Tag

四者是不同东西，现在混用了：

| 名称 | 用途 | 规格 |
|---|---|---|
| **Pill** | 可点击的筛选/切换 | h 28，radius 999，1px 边框 |
| **Chip** | 输入框内的已选项（文件、技能） | h 28，radius 8，可带 × |
| **Badge** | 状态指示（只读） | h 20，radius 4，字 11/500 |
| **Tag** | 分类标签（只读） | h 22，radius 4，底 `--surface-sunken` |

规则：状态类一律 Badge，不用 Pill 伪装成状态。

### 4.5 Tabs

**只保留一种。** 统一下划线型（更贴合「工具」定位）：

- 容器高 44，底边 1px `--line`；
- 项：h 44，padding 0 12，字 13/400，色 `--text-tertiary`；
- hover：文字 `--text-primary`；
- selected：文字 `--text-primary` + 600 + 底部 2px `--accent`；
- focus-visible：环；
- 溢出横向滚动，滚动条隐藏。

删除 `pill` 变体在 `pane-toolbar` 的覆盖写法（现在的双重定义）。设置页左导航属于 **Nav**，不是 Tabs，单独定义：h 36、radius 8、selected 白底 + 1px 边框。

### 4.6 Menu / Dropdown

- 面板：`--surface-card`、1px `--line`、radius 12、`e2`、padding 4；
- 项：h 30、radius 8、padding 0 10、字 13；
- hover：`--surface-hover`；selected：`--accent-soft` + `--accent` 勾；
- 分组标题：11/500、`--text-tertiary`、padding 6 10 2；
- 键盘：↑↓ 移动、Enter 选中、Esc 关闭、Tab 关闭；
- 打开时焦点进入第一项；关闭后焦点回到触发按钮；
- 位置：优先下方，空间不足翻上；不得超出视口 8px。

### 4.7 Tooltip

- 底 `rgba(30,27,24,.94)`、字 `#f9fafb`、12px、radius 8、padding 5 9、`e2`；
- 延迟 400ms 出现，移出立即消失；
- 只放一句短语 + 可选快捷键；
- 不承载操作，不承载长文案。

### 4.8 Toast

- 底部居中，距底 24；
- radius 999（单行）/ 12（多行）；
- 变体：default / success / danger，各带 12px 图标；
- 时长：3s；带撤销的 6s；
- 同一时刻最多 1 条，新条替换旧条。

### 4.9 Dialog / Confirm（当前缺失）

现在 5 处破坏性操作使用原生 `confirm()`，必须替换。

| 项 | 值 |
|---|---|
| 遮罩 | `rgba(30,27,24,.44)` + `blur(2px)` |
| 面板 | 宽 420、radius 16、padding 20、`e3` |
| 标题 | 16 / 600 |
| 正文 | 13 / `--text-secondary` |
| 操作 | 右对齐，ghost + danger 两个按钮 |
| 焦点 | 打开聚焦「取消」，Esc 取消，点击遮罩取消 |
| 危险操作 | 按钮文案必须是动词（「清空历史」），不得写「确定」 |

有撤销能力的操作（删除单条记忆、归档条目）优先用 Toast 撤销，不用 Dialog。

### 4.10 Empty State

只允许**一个**空态组件，结构固定：

```
[可选图形 48]
标题（16/600，一句话说清能做什么）
说明（13/--text-secondary，≤2 行）
主行动（1 个 primary 按钮 / 或直接聚焦输入框）
可选：4 条示例（单列、单行截断、手动「换一批」，不是轮播）
```

禁止：第二张引导卡、超大排版、自动轮播。

### 4.10.1 推荐位（广告）

首屏底部允许有一条推荐位，但它是**页脚注脚**，不是卡片墙。

| 项 | 规定 |
|---|---|
| 形态 | 一条发丝线起头，三栏横排，竖线分隔；**没有卡片盒、没有圆角、没有阴影、没有插画** |
| 标注 | 组头写一次「推荐 · 广告」，不逐卡重复盖章；同屏多条广告时才逐条标 |
| 层级 | 栏序号用等宽 10.5px，标题用楷体 16.5–19px，说明 12.5px，CTA 用链接色 |
| 权重 | 第一栏是主张，字号大一级；三栏不等权，才有主次 |
| 悬停 | 底色抬到卡面白 + 标题转链接色 + 箭头位移 2px；不做上浮、不做阴影 |
| 宽度 | ≥640px 三栏；<640px 单列，改用横向发丝线分隔 |
| 禁止 | 实景插画、大地色、渐变底、营销式大标题、自动轮播 |
| 可达 | 整栏是一个链接；`rel="noopener sponsored"`；键盘可见焦点 |

> 为什么不做成卡片：标题已经 92px，下面再放三个盒子会立刻变成落地页。
> 索引条是唯一能和这套排版共存、又不抢主标题的形式。

### 4.11 Loading / Skeleton

- 首屏骨架：灰块 + shimmer，形状必须贴近真实内容；
- 行内加载：14px 旋转环 + 文案；
- 流式生成：文字光标 `▍` + 状态徽章，不用整块骨架；
- 超过 8s 追加「仍在生成…」；超过 30s 给出取消入口。

### 4.12 Card

- 底 `--ui-band`（极浅，`rgba(17,24,39,.035)`）、**无描边**、radius 14、padding 18/20、`e0`；
- 卡片里再放 Table / Sheet / CodeBlock 时，内层去掉自己的外框与底色，交给卡片统一；
- `sunk` 变体加深一档（`--ui-band-strong`），用来表示块内更内层；
- `outline` 变体保留 1px 线，只在底色用不了的地方（深色底、图片上）用；
- 卡片内标题 14/600，正文 13/1.65。

### 4.13 Table

- 表头：11/500、`--ui-ink-3`、底 `--ui-band-strong`、下边框 1px `--ui-line-strong`；
- 行：下边框 1px `--ui-line`、hover `rgba(17,24,39,.03)`；
- 数字右对齐 + `tabular-nums` + `font-feature-settings: "tnum"`；
- 首列给 500 字重，作为每一行的锚点；
- 空表给一行说明，不给空白；
- 生成内容的表格与设置页表格共用同一套。

### 4.13.1 组件分层清单

按 §2.6.1 的三层归属，新增组件时照这张表选，不要临时发明第四种边界。

| 层 | 组件 |
|---|---|
| ① 块（`--ui-band`） | Card、Table、Sheet、Audio、CodeBlock、AccordionItem、Citation、TextCallout / Callout、Entity、OptionCard、Placeholder 骨架 |
| ① 块（`--ui-band-strong`） | 表头、AccordionItem 展开态、`sunk` 变体、Tag / IconTag 中性态、Tabs 轨道、ProgressBar / SegmentedBar / TaskList / Slider 轨道、Steps 圆点 |
| ② 块内（`--ui-line`） | Table 行线、Sheet 单元格横线与标题栏、CodeBlock 标题栏、Markdown 表格 / 分隔线 / 引用左条、TaskList 行线、Gallery 间隔 |
| ③ 控件（`--ui-line-strong`） | Button secondary、Input / TextArea / Select、Chip、Chips 选中前的边、SwitchItem、CheckBox、Slider 拇指环、TaskList 勾选框与按钮、图片 / 视频 / 地图 / 白底画布的外框、Stack `bordered` |

**不参与分层**的（用文字层级或语义色，不给边界）：MetricIndicator、TextContent、RichText、InlineHeader、CardHeader、Separator（只有一条线）、Cite 内文。

### 4.14 Status Badge

- 语义：idle / busy / ok / warn / bad，五态固定；
- 必须**颜色 + 文字**双编码；
- 尺寸 h 20、padding 0 8、radius 4、字 11/500；
- busy 可带 10px 呼吸点，但不得只靠动画表达。

---

## 5. 交互模式

### 5.1 主行动

每屏只有一个 primary。首屏的 primary 是「输入框」，不是「打开设置」，更不是广告。

### 5.2 焦点与键盘

- 所有可交互元素必须有 `:focus-visible`，统一 `0 0 0 3px var(--accent-ring)`；
- 禁止在未提供替代样式时写 `outline:none`；
- 全局快捷键：`⌘/Ctrl+Enter` 发送、`Esc` 关闭浮层、`⌘[ / ⌘]` 版本切换；
- 菜单与对话框必须支持方向键与 Esc；
- 焦点不得丢失：浮层关闭后回到触发元素。

### 5.3 破坏性操作

1. 单条、可恢复 → 直接执行 + Toast 撤销（6s）；
2. 批量、不可恢复 → Dialog + 动词按钮 + 说明后果；
3. 永不使用原生 `confirm()`；
4. 危险按钮不放在主行动位。

### 5.4 空态

见 4.10。首屏 = 一个空态 + 一个输入入口，不做三层叙事。

### 5.5 加载与流式

- 0–300ms：不显示加载，避免闪烁；
- 300ms–8s：骨架或旋转环；
- 流式：先出骨架，再逐块替换；状态徽章从 `busy` 到 `ok/bad`；
- 失败：错误就地展示在内容区，附「重试」，不要只把工具栏的刷新按钮变红。

### 5.6 错误

错误三段式：**发生了什么 → 为什么 → 下一步**。
例：「模型没有响应（429）。当前 Key 的额度用完了。换一个模型或稍后重试。」+ 两个按钮。

### 5.7 长列表

>20 条必须提供：搜索、按时间分组（今天 / 昨天 / 更早）、当前项高亮。
历史会话 25 条目前无搜索、无分组。

### 5.8 拖拽

- 可拖区域有 8px 热区（现在 `pane-grip` 16px，合格）；
- 拖动时全局 `cursor: col-resize` + 禁止选中；
- 松手吸附到 360 / 400 / 480 / 560 四档；
- 双击恢复默认宽度；
- 键盘可达：`←/→` 调整 16px，`Home` 回默认。

### 5.9 动效原则

- 只解释空间关系（从哪来、到哪去），不做装饰；
- 进入 280ms，退出 180ms（退出更快）；
- 同屏同时只跑一条主动效；
- 频繁操作（页签）用 CSS，不用 View Transition。

---

## 6. 无障碍基线

| 项 | 标准 |
|---|---|
| 正文对比度 | ≥ 4.5:1 |
| 大字号（≥24 或 ≥18.66 粗体） | ≥ 3:1 |
| 占位符 | ≥ 4.5:1 |
| 点击目标 | 桌面 ≥ 24×24；触屏 ≥ 44×44 |
| 焦点可见 | 100% 可交互元素 |
| 状态表达 | 不得只靠颜色 |
| 动画 | 尊重 `prefers-reduced-motion` |
| 语义 | 按钮用 `button`，链接用 `a`，弹层 `role="dialog"` + `aria-modal` |
| 图标 | 有 `aria-label` 或伴随文字 |
| 表格 | 有表头与 `scope` |
| 表单 | 有显式 `<label>`，错误用 `aria-describedby` |

现状不达标清单：

| 问题 | 证据 | 修法 |
|---|---|---|
| `--dim #9ca3af` 2.54:1 | `app.css:22` | 拆成 placeholder 4.60 / disabled 2.x |
| 首屏小标签 3.31:1 | `app.css:670` | 提到 4.5:1 |
| ~~例子轮播圆点 6×6px~~ | 已改 | 删除轮播与圆点，改 4 条单列 + 手动换一批 |
| 历史删除按钮 opacity 0 | `app.css:268` | 常驻 60% |
| 大量组件无 focus 样式 | `app.css` 仅 11 处 `focus-visible` | 统一补 |

---

## 7. 内容与文案

| 规则 | 说明 |
|---|---|
| 人称 | 第二人称「你」，不用「您」 |
| 语气 | 短句、说人话、不卖萌、不堆术语 |
| 按钮 | 动词开头：「开始压缩」「清空历史」 |
| 标题 | 名词短语，不加句号 |
| 说明 | ≤2 行，先说做什么，再说影响 |
| 数字 | tabular-nums、千分位、单位统一 |
| 语言 | 中文为主；英文只做品牌/术语；不中英夹句 |
| 错误 | 发生了什么 + 为什么 + 下一步 |
| 空态 | 一句话说清能做什么，不做营销 |

保留现有资产：「安静的画布，正在生长的界面」这类品牌句是差异化，不要为了「专业」把它删掉——把它限制在首屏与品牌位置。

---

## 8. 现状迁移映射

### 8.1 变量映射

| 旧变量 | 旧值 | 新 token | 动作 | 已执行 |
|---|---|---|---|---|
| `--bg` | `#fff` | — | 删除（0 引用） | 待 |
| `--shell` | `#fff` | `--surface-canvas` | 改值 `#fafbfc` | ✅ |
| `--panel` | `#f7f7f8` | `--surface-sunken` | 改值 `#f4f5f6` | ✅ |
| `--panel-2` | `#f1f1f3` | `--surface-active` | 改值 `#eef0f2` | ✅ |
| `--border` | `#e5e7eb` | `--line` | 改值 `#e6e8eb` | ✅ |
| `--border-soft` | `#f1f2f4` | `--line-soft` | 改值 `#f0f1f3` | ✅ |
| `--text` | `#1f2937` | `--text-primary` | 改值 `#17191d` | ✅ |
| `--muted` | `#4b5563` | `--text-secondary` | 改值 `#4c525b` | ✅ |
| `--subtle` | `#6b7280` | `--text-tertiary` | 改值 `#646b75` | ✅ |
| `--dim` | `#9ca3af` | `--text-placeholder` | 改值 `#697079`（原 2.54:1） | ✅ |
| `--accent` | `#4f46e5` | `--accent` | 改值 `#223d36`（松绿） | ✅ |
| `--accent-hover` | `#4338ca` | `--accent-hover` | 改值 `#16281f` | ✅ |
| `--accent-soft` | `#eef2ff` | `--accent-soft` | 改值 `#edf2f0` | ✅ |
| `--accent-line` | `#c7d2fe` | `--accent-line` | 改值 `#ccd8d2` | ✅ |
| `--accent-ring` | `rgba(79,70,229,.16)` | 同 | 改值 `rgba(34,61,54,.14)` | ✅ |
| `--primary-fill` | 渐变 | — | 改纯色 `var(--accent)` | ✅ |
| `--primary-shadow` | 5 层 | `--e1` | 换成 2 层柔和投影 | ✅ |
| `--warn` | `#b45309` | `--warning-fg` | 改值 `#8a5a12` | ✅ |
| `--danger` | `#dc2626` | `--danger-fg` | 改值 `#b3261e` | ✅ |
| `--ok` | `#16a34a` | `--success-fg` | 改值 `#1f6b3f` | ✅ |
| `--info` | `#2563eb` | `--info-fg` | 改值 `#2f4c7a` | ✅ |
| `--chart-0…5` | 蓝紫橙青粉绿 | `PALETTE` | 改低饱和 6 色（`palette.js`） | ✅ |
| `--sans` | 文楷 | `--font-ui` + `--font-editorial` | 拆分，`--sans` 留作兼容别名 | ✅ |
| `--mono` | — | `--font-mono` | 保留 | ✅ |
| `--chat-w` | `400px` | `--layout-chat` | 改名 | 待 |

> 已执行项对应 commit `style(web): 字体分家` 之后的「冷白 + 纯墨」改动。

### 8.2 逐文件改造点

| 文件 | 改动 | 风险 |
|---|---|---|
| `apps/web/css/app.css` | token 层替换；删除 `--primary-fill/shadow`；统一 tab / radius / shadow | 中，涉及全站 |
| `apps/web/css/fonts.css` | 保留，但不再作为 `--font-ui` | 低 |
| `packages/catalog/src/tokens.js` | `text` 的 weight 600 降至「仅真实字重」；补 `--font-ui` 使用 | 中，影响生成内容 |
| `packages/catalog/src/styles.js` | `.btn` / `.input` / `.tag` 对齐 4.x 规格 | 中 |
| `apps/web/index.html` | 内联 SVG 的 stroke/尺寸统一；首屏删广告、例子收 4 条 + 手动换一批 | 低 |
| `apps/web/src/settings-page.js` | `confirm()` → Dialog；内容宽统一 640 | 低 |
| `apps/web/src/chat.js` | 「来源」降级为无边框小字；发送键改单箭头 + 快捷键在 tooltip；用量常驻显示 | 低 |

### 8.3 明确不做

- 不改 OpenUI Lang、编译、沙箱、渲染链路；
- 不换组件库、不引入 CSS 框架；
- 不重写业务逻辑；
- 不在本轮引入暗色主题（先把 token 分层做好，暗色只需覆盖 semantic 层）。

---

## 9. 评审 Checklist

提交 UI 改动前逐条勾：

- [ ] 新增颜色是 semantic token，组件里没有 hex
- [ ] 字号来自 8 档字阶，没有 12.5 / 13.5
- [ ] 圆角来自 5 档，没有 7 / 9 / 10
- [ ] 间距是 4 的倍数
- [ ] 没有新增伪粗体（字重只有 400 / 600 / 700）
- [ ] 所有可交互元素有 focus-visible
- [ ] 文本对比度 ≥ 4.5:1（用附录 A 核对）
- [ ] 点击目标 ≥ 24×24
- [ ] 状态不只靠颜色
- [ ] hover-only 的控件已检查（触屏可见）
- [ ] 破坏性操作走 Dialog 或 Toast 撤销
- [ ] 空态没有营销内容
- [ ] 本屏只有一个 primary
- [ ] 动效只用 4 个时长 / 2 条曲线
- [ ] `prefers-reduced-motion` 下不崩
- [ ] 新增 z-index 来自层级表
- [ ] 新增图标 stroke 1.7 / 尺寸 14·16·20·24

---

## 10. 落地路线

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **P0-a** | 字体分家 + 删除伪粗体 | 质感立刻提升 | 0.5 天 |
| **P0-b** | token 层建立（本文 §2.10） | 一份 `:root` | 0.5 天 |
| **P0-c** | 对比度修复（placeholder / 首屏标签 / 圆点热区） | 无障碍达标 | 0.5 天 |
| **P1-a** | 组件收敛：Tabs 单一形态、Button 去拟物、Badge 统一 | 视觉一致 | 1 天 |
| **P1-b** | Dialog 替代 confirm；Toast 撤销 | 交互完整 | 1 天 |
| **P1-c** | 首屏重构：删广告、例子收 3 条、主行动聚焦 | 首屏可用 | 1 天 |
| **P2-a** | 聊天区信息降噪（来源移出、次要按钮收进菜单） | 密度下降 | 0.5 天 |
| **P2-b** | 设置页宽度统一、分组重排 | 可读性 | 0.5 天 |
| **P2-c** | 暗色主题（只覆盖 semantic 层） | 可扩展 | 1 天 |

每个阶段结束跑一次 §9 checklist。

---

## 附录 A · 对比度实测

当前（冷白 + 纯墨，已落地）与初版（暖纸）的实测对照：

| 组合 | 比值 | 判定 |
|---|---|---|
| **当前 · `#17191d` / `#fafbfc`（一级）** | **16.87** | ✅ |
| **当前 · `#4c525b` / `#fafbfc`（二级）** | **7.55** | ✅ |
| **当前 · `#646b75` / `#fafbfc`（三级）** | **5.16** | ✅ |
| **当前 · `#646b75` / `#f4f5f6`（沉底）** | **4.93** | ✅ |
| 当前 · `#2b5548` / `#ffffff`（链接） | 8.41 | ✅ |
| 当前 · 白字 / `#223d36`（主按钮） | 11.74 | ✅ |
| 当前 · 状态四组 fg/bg | 5.1 / 4.8 / 5.3 / 6.4 | ✅ |
| 初版 · `#9ca3af` / `#fff`（旧 `--dim`） | 2.54 | ❌ 已修 |
| 初版 · `#8a8178` / `#f3eee6`（首屏标签） | 3.31 | ❌ 已修 |
| 初版 · `#1f2937` / `#fff`（旧 text） | 14.68 | ✅ |
| 初版 · `#6b7280` / `#f7f7f8` | 4.52 | ⚠️ |

> **已修**：`--subtle` 从 `#697079`（4.45:1）加深到 `#646b75`（5.16:1 on 画布 / 4.93:1 on 沉底），
> 三级文字现在在任何底色上都过 AA。`--dim #a6adb8` 只剩禁用态用（豁免）。

## 附录 B · 术语

| 术语 | 含义 |
|---|---|
| 双表面 | Canvas（冷白）与 Chrome（纯白卡面）两套底色，共用一套 token |
| Primitive | 物理色值，不可直接用于组件 |
| Semantic | 语义角色，组件唯一可用层 |
| 伪粗体 | 字体未提供该字重时，浏览器合成的加粗 |
| e0–e3 | 四级高度（阴影） |
| 主行动 | 当前屏鼓励用户做的唯一操作 |
