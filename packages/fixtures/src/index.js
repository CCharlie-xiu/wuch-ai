// ─────────────────────────────────────────────────────────────────────────────
// 离线演示：几条预先写好的 OpenUI Lang，按 token 节奏吐出来。
// 走的是和真实模型完全相同的链路：server.append() → 编译 → patch → worker。
//
// 写法约定：root 写在第一行，先出骨架；子组件按出现顺序往下写，
// 流式过程中写到哪一行，界面就补到哪一块。
// ─────────────────────────────────────────────────────────────────────────────

export const DEMOS = [
  {
    id: 'team-plan',
    title: '团队版估算',
    hint: '指标 + 表格 + 表单，提交后开启下一轮',
    prompt: '做一个团队版的费用估算，能填席位数看月费',
    bindings: {},
    source: `root = Stack([title, intro, board], "column", "l")
title = TextContent("团队版估算", "xl-heavy")
intro = TextContent("价格按席位线性计算，年付再省 20%。填好席位数提交，我按你的团队规模细算。", "default", true)
board = Grid([m1, m2, m3, plans, estimate], 3)
m1 = MetricIndicator("团队版", "$29/席/月", "最常选", "flat")
m2 = MetricIndicator("8 席月费", "$232", "年付 $2,227", "down")
m3 = MetricIndicator("企业版起步", "$49/席/月")
plans = GridItem([Card([CardHeader("方案对比", "团队版包含 SSO、审计日志和优先支持"), planTable])], 2)
planTable = Table([Col("能力"), Col("团队版"), Col("企业版")], [["SSO", "✓", "✓"], ["审计日志", "90 天", "无限"], ["优先支持", "工作日", "7×24"], ["专属客户经理", "—", "✓"]], true)
estimate = Card([CardHeader("按你的团队估算"), form])
form = Form("estimate", [seatsField, billingField], actions)
seatsField = FormControl("席位数", Input("seats", "例如 8", "number"), "1 – 500")
billingField = FormControl("付费方式", Select("billing", [SelectItem("monthly", "月付"), SelectItem("yearly", "年付（省 20%）")], "选择付费方式"))
actions = Buttons([Button("算一下", "submit:estimate", "primary"), Button("对比企业版", "turn:团队版和企业版逐项对比，给出 30 人团队的选择建议", "secondary")])
summary = [Note("按席位线性计价", "团队版 $29/席/月，8 席月费 $232；年付再省 20%，约 $2,227/年。", ["m1", "m2"]), Note("团队版已够用", "SSO、90 天审计日志和工作日优先支持都包含在团队版里，企业版多的是无限审计和专属客户经理。", ["planTable"]), Note("填席位数细算", "在下方表单填席位数和付费方式，提交后按你的规模给出精确报价。", ["form"])]
`,
  },

  {
    id: 'dinner',
    title: '周日晚餐',
    hint: '服务端解析图片 + 表格 + 提示框',
    prompt: '安排一顿给朋友的周日晚餐，慢烤羊肩，采购量按 4 人算',
    bindings: {},
    source: `root = Stack([title, board, next], "column", "l")
title = TextContent("周日晚餐 · 慢烤羊肩", "xl-heavy")
board = Grid([hero, intro, tips, shopping, timing], 3)
hero = GridItem([AsyncImage("slow roasted rosemary garlic lamb shoulder browned golden in a baking tray", "16:9", "100%", "慢烤迷迭香蒜香羊肩")], 2)
intro = Card([CardHeader("4 人份 · 约 4 小时"), TextContent("给 4 位朋友的慢烤羊肩。生肉按 280g/人备，提前 2 小时回温，烤之前抹盐和橄榄油。", "default")])
shopping = GridItem([Card([CardHeader("采购清单", "按 4 人换算"), shoppingTable])], 2)
shoppingTable = Table([Col("食材"), Col("用量"), Col("备注")], [["羊肩", "1.1 kg", "带骨，提前 2 小时回温"], ["小土豆", "5 个", "对半切"], ["迷迭香", "2 枝", "新鲜"], ["大蒜", "1 头", "整瓣拍裂"], ["柠檬", "1 个", "出锅前挤汁"]], true)
tips = TextCallout("info", "火候", "180°C 先烤 30 分钟上色，转 160°C 再烤 90 分钟；超过 6 人建议分两盘烤。")
timing = Card([CardHeader("时间安排"), timeline])
timeline = Timeline([TimelineItem("回温", "14:00", "done", "羊肩出冰箱，抹盐"), TimelineItem("上色", "16:00", "active", "180°C 30 分钟"), TimelineItem("慢烤", "16:30", "todo", "160°C 90 分钟，中途刷一次油"), TimelineItem("静置上桌", "18:00", "todo", "锡纸盖 15 分钟再切")])
next = Buttons([Button("改成 8 人份", "turn:同样的菜单改成 8 人份，采购量和火候都重新算", "primary"), Button("加一道配菜", "turn:给这顿慢烤羊肩配一道清爽的配菜", "secondary")])
summary = [Note("4 人份采购", "羊肩 1.1 kg（280g/人），配小土豆、迷迭香、大蒜和柠檬。", ["shoppingTable"]), Note("两段火候", "180°C 上色 30 分钟，再 160°C 慢烤 90 分钟，出炉静置 15 分钟。", ["tips", "timing"]), Note("14:00 开始准备", "羊肩提前 2 小时回温，18:00 可以上桌。", ["timing"])]
`,
  },

  {
    id: 'dashboard',
    title: '分析仪表盘',
    hint: '折线 / 饼图 / 柱状图 + 指标 + 选项卡 + 折叠',
    prompt: '给产品做一个分析仪表盘，包含用量、获客、功能采用和收入',
    bindings: {},
    source: `root = Stack([title, board, faq], "column", "l")
title = TextContent("产品分析仪表盘", "xl-heavy")
board = Grid([m1, m2, m3, mauCard, acquisition, m4, goal, adoption, detail], 3)
goal = GridItem([Card([CardHeader("任务达成率", "每月按期完成的任务占比"), LineChart(["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"], [Series("任务达成率", [32, 47, 61, 52, 24, 50, 41, 47, 63, 84, 72, 48])], "natural", "月份", "%")])], 2)
m1 = MetricIndicator("月活 (MAU)", "128,400", "+6.2%", "up")
m2 = MetricIndicator("新增用户 (30d)", "24,950", "+3.1%", "up")
m3 = MetricIndicator("MRR", "¥412,000", "+4.4%", "up")
m4 = MetricIndicator("流失率", "1.8%", "-0.3pt", "down")
mauCard = GridItem([Card([CardHeader("月活用户", "最近 12 个月"), mauChart])], 2)
mauChart = LineChart(["4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月", "1月", "2月", "3月"], [Series("MAU", [84500, 87200, 90100, 93800, 96500, 100200, 104800, 109600, 114300, 119900, 123700, 128400]), Series("新增", [12800, 13400, 14100, 14900, 15600, 16400, 17300, 18100, 19000, 20100, 21300, 22500])], "monotone", "月份", "人")
acquisition = Card([CardHeader("获客构成", "最近 30 天"), PieChart([Slice("自然搜索", 34), Slice("付费搜索", 22), Slice("推荐", 16), Slice("社交", 12), Slice("直接 / 其他", 16)], "donut")])
adoption = Card([CardHeader("功能采用", "周活用户"), BarChart(["仪表盘", "自动化", "集成", "协作", "导出"], [Series("周活", [48200, 31750, 28900, 27100, 19850])])])
detail = GridItem([Card([Tabs([TabItem("table", "功能明细", [featureTable]), TabItem("notes", "解读", [TextContent("仪表盘和自动化贡献了六成周活；导出的人均次数最低，适合放进新手引导。")])])])], 2)
featureTable = Table([Col("功能"), Col("周活用户", "number"), Col("采用率 (%)", "number"), Col("人均次数", "number")], [["仪表盘", 48200, 62.5, 5.8], ["自动化", 31750, 41.2, 3.1], ["集成", 28900, 37.5, 2.4], ["协作", 27100, 35.2, 4.6], ["导出", 19850, 25.8, 1.7]], true)
faq = Accordion([AccordionItem("cac", "为什么建议盯 CAC 而不是只盯增长", [TextContent("付费搜索占新增的 22%，但贡献了 41% 的获客成本。先按渠道拆 CAC，再看转化率，才能解释结构变化。")]), AccordionItem("churn", "流失率的口径", [TextContent("这里用的是月度 logo 流失率，不含降级。若含降级会到 2.6%。")])])
summary = [Note("增长稳健", "月活 128,400，12 个月涨了 52%；MRR ¥412,000，环比 +4.4%。", ["m1", "m3", "mauChart"]), Note("获客看自然搜索", "自然搜索占 34% 最大；付费搜索 22% 但成本最高，建议按渠道拆 CAC。", ["acquisition", "faq"]), Note("导出功能偏弱", "导出采用率 25.8%、人均 1.7 次，是最该放进新手引导的功能。", ["adoption", "featureTable"])]
`,
  },

  {
    id: 'moodboard',
    title: '狗狗背心方向',
    hint: '选项卡片 + 标签 + 复选，表单提交开启下一轮',
    prompt: '帮我定一个狗狗背心的设计方向，先选风格和主色',
    bindings: {},
    source: `root = Stack([title, intro, refs, direction], "column", "l")
title = TextContent("狗狗背心方向", "xl-heavy")
intro = TextContent("先定基调，再往下做设计概念。选好之后提交，我按你的选择出设计概念。", "default", true)
refs = Grid([AsyncImage("dog vest moodboard cozy knit and technical shell fabrics flat lay", "4:3", "100%", "材质参考"), AsyncImage("reflective dog harness strap details close up stitching", "1:1", "100%", "反光细节"), TextCallout("info", "怎么选", "夜间遛狗多就偏 Technical；室内保暖为主就偏 Cozy。")], 3)
direction = Card([CardHeader("选方向", "点选不产生模型调用，提交时一次带上"), form])
form = Form("moodboard", [styleField, colorField, detailField], submit)
styleField = FormControl("风格", OptionCards("style", [OptionCard("cozy", "Cozy", "针织、暖调、居家", "sparkles"), OptionCard("technical", "Technical", "硬壳、户外、机能", "settings"), OptionCard("minimal", "Minimal", "素色、极简、日常", "star")], "row"))
colorField = FormControl("主色", Chips("color", ["sand", "olive", "charcoal", "rust"]))
detailField = FormControl("细节", CheckBoxGroup("details", [CheckBoxItem("reflective", "反光细节（夜间遛狗）", true), CheckBoxItem("adjustable", "可调肩带"), CheckBoxItem("pocket", "拾便袋口袋")]))
submit = Buttons([Button("就这个方向，出设计概念", "submit:moodboard", "primary")])
summary = [Note("三个风格方向", "Cozy 偏针织暖调，Technical 偏户外机能，Minimal 偏素色日常。", ["styleField"]), Note("先定主色和细节", "主色四选一；反光细节默认勾上，夜间遛狗更安全。", ["colorField", "detailField"]), Note("提交后出概念", "选择在本地生效，点提交时一次性带给我。", ["submit"])]
`,
  },

  {
    id: 'release',
    title: '上线计划',
    hint: '步骤条 + 时间线 + 进度条 + 代码块',
    prompt: '给我一个灰度上线的计划，按时间线展示',
    bindings: {},
    source: `root = Stack([title, board, next], "column", "l")
title = TextContent("灰度上线计划", "xl-heavy")
board = Grid([overview, errRate, timeline, p95, rollback], 3)
overview = GridItem([Card([CardHeader("发布节奏", "每一步都可回滚"), Steps(["代码冻结", "内测", "灰度 5%", "灰度 50%", "全量"], 2), ProgressBar(5, 100, "当前放量 5%")])], 2)
errRate = MetricIndicator("错误率", "0.12%", "阈值 0.5%", "flat")
p95 = MetricIndicator("P95 延迟", "182 ms", "阈值 300 ms", "flat")
timeline = GridItem([Card([CardHeader("时间线", "灰=未开始，绿=已完成，青=进行中"), Timeline([t1, t2, t3, t4, t5])])], 2)
t1 = TimelineItem("代码冻结", "T-3 天", "done", "只接受修复类提交，CI 全绿才能进发布分支。")
t2 = TimelineItem("内测", "T-1 天", "done", "内部账号全量走一遍主链路，看错误率有没有抬头。")
t3 = TimelineItem("灰度 5%", "T+0", "active", "按用户 ID 取模放量，观察 30 分钟再决定下一步。")
t4 = TimelineItem("灰度 50%", "T+2 小时", "todo", "错误率和 P95 都在阈值内才继续。")
t5 = TimelineItem("全量", "T+6 小时", "todo", "全量后 24 小时保持回滚窗口。")
rollback = Callout("warning", "回滚开关", CodeBlock("flags set release.v2 --percent 0", "bash"))
next = Buttons([Button("出回滚清单", "turn:按这个上线计划给我一份回滚清单：每一步的触发条件、执行动作、责任人，用时间线列出来。", "primary")])
summary = [Note("五步放量", "代码冻结 → 内测 → 灰度 5% → 50% → 全量，当前在灰度 5%。", ["overview", "timeline"]), Note("每步都有门槛", "错误率和 P95 在阈值内才继续放量，全量后保留 24 小时回滚窗口。", ["t4", "t5"]), Note("一条命令回滚", "把 release.v2 的放量比例设回 0 即可。", ["rollback"])]
`,
  },
  {
    id: 'sigmoid',
    title: 'Sigmoid 函数',
    hint: '公式（独占一行 / 行内）+ 折线图',
    prompt: '讲讲 sigmoid 函数，给出公式、导数和图像',
    bindings: {},
    source: `root = Stack([title, intro, board, next], "column", "l")
title = TextContent("Sigmoid 函数速览", "xl-heavy")
intro = TextContent("把任意实数压到 0 到 1 之间，常用来把打分变成概率。", "default", true)
board = Grid([def, deriv, props, curve], 2)
def = Card([CardHeader("定义", "Logistic 函数"), Formula("\\\\sigma(x) = \\\\frac{1}{1 + e^{-x}}")])
deriv = Card([CardHeader("导数", "用函数值自己就能算"), Formula("\\\\sigma'(x) = \\\\sigma(x)\\\\,\\\\bigl(1 - \\\\sigma(x)\\\\bigr)")])
props = Card([CardHeader("性质"), Stack([sym, limit, mid], "column", "s")])
sym = Stack([TextContent("对称："), Formula("\\\\sigma(-x) = 1 - \\\\sigma(x)", null, "inline")], "row", "s", "baseline")
limit = Stack([TextContent("极限："), Formula("\\\\lim_{x \\\\to +\\\\infty} \\\\sigma(x) = 1,\\\\quad \\\\lim_{x \\\\to -\\\\infty} \\\\sigma(x) = 0", null, "inline")], "row", "s", "baseline")
mid = Stack([TextContent("中点："), Formula("\\\\sigma(0) = \\\\tfrac{1}{2}", null, "inline")], "row", "s", "baseline")
curve = Card([CardHeader("图像", "x 从 -6 到 6"), LineChart(["-6", "-4", "-2", "0", "2", "4", "6"], [Series("σ(x)", [0.0025, 0.018, 0.119, 0.5, 0.881, 0.982, 0.9975])], "natural", "x", "σ(x)")])
next = Buttons([Button("和 tanh 比一比", "turn:把 sigmoid 和 tanh 放在一起比较：公式、值域、导数和各自适合的场景。", "primary")])
summary = [Note("定义", "σ(x) = 1 / (1 + e^-x)，输出在 0 到 1 之间。", ["def", "curve"]), Note("导数", "σ'(x) = σ(x)(1 − σ(x))，反向传播时直接复用前向结果。", ["deriv"]), Note("关键性质", "关于 (0, 1/2) 中心对称，两端趋于 0 和 1。", ["props"])]
`,
  },
  {
    id: 'limit',
    title: '极限入门',
    hint: '可拖动的函数图像 + 公式 + 说明',
    prompt: '用交互的方式讲清楚极限：拖动看 x 逼近 2 时 x+1 趋近哪个数',
    bindings: {},
    source: `root = Stack([title, intro, board, next], "column", "l")
title = TextContent("交互式学极限", "xl-heavy")
intro = TextContent("求极限看的是 x 越来越接近某个数时 y 趋向哪里 —— 不要求 x 正好等于那个数。下面这张图可以拖。", "default", true)
board = Grid([def, graph, read], 2)
def = Card([CardHeader("这一节研究", "x 趋近 2"), Formula("\\\\lim_{x \\\\to 2} (x + 1) = 3")])
graph = GridItem([Card([CardHeader("函数图像", "拖动滑块看 x 逼近 2"), plot])], 2)
plot = FunctionPlot("x + 1", -1, 5, 2, "y = x + 1")
read = Card([CardHeader("怎么读这张图"), guide])
guide = MarkDownRenderer("1. 拖动滑块，让 x 靠近 2\\n2. 橙点沿直线滑向 (2, 3)\\n3. 两条虚线给出当前的 x 和 y\\n\\n> 不管从左边还是右边靠近，y 都趋向 3 —— 这就是极限。")
next = Buttons([Button("换个函数试试", "turn:把函数换成 (x^2 - 4)/(x - 2)，讲清楚为什么 x=2 处没有定义、极限却是 4", "primary")])
summary = [Note("极限看趋势", "x 趋近 2 时 y 趋近 3，与 x 是否等于 2 无关。", ["def", "plot"]), Note("自己拖一下", "拖动滑块，橙点和虚线实时跟着动，不产生模型调用。", ["plot"]), Note("下一轮", "换成 (x²-4)/(x-2)：x=2 处没定义，极限却是 4。", ["next"])]
`,
  },
  {
    id: 'study-plan',
    title: '学习进度表',
    hint: '任务清单 + 进度条，可以点着勾',
    prompt: '给我一份 13 周的世界历史学习计划，做成可以勾选的任务看板',
    bindings: {},
    source: `root = Stack([title, intro, board, next], "column", "l")
title = TextContent("世界历史学习计划", "xl-heavy")
intro = TextContent("下面这份清单可以直接当任务看板用。每完成一项就点一下圆圈，进度条和计数会跟着走 —— 点选只在本地生效，不会打扰我。", "default", true)
board = Grid([done, hours, tasks, tip], 2)
done = MetricIndicator("总进度", "2 / 7 阶段", "前两段已完成", "flat")
hours = MetricIndicator("已投入", "18 小时", "约 3 小时/周", "flat")
tasks = GridItem([Card([CardHeader("我的世界历史任务", "13 周 · 7 个阶段"), list])], 2)
list = TaskList([w1, w2, w3, w4, w5, w6, w7])
w1 = TaskItem("第 1 周：文明的诞生", "农业革命、四大早期文明、城市与国家", true)
w2 = TaskItem("第 2~3 周：古典文明", "希腊、波斯、罗马、古印度、秦汉", true)
w3 = TaskItem("第 4~5 周：中世纪世界", "拜占庭、伊斯兰文明、欧洲中世纪、唐宋与蒙古")
w4 = TaskItem("第 6~7 周：全球联系", "文艺复兴、宗教改革、大航海与殖民扩张")
w5 = TaskItem("第 8~9 周：革命与工业化", "启蒙运动、政治革命、工业革命、帝国主义")
w6 = TaskItem("第 10~11 周：世界大战与冷战", "两次世界大战、冷战、去殖民化")
w7 = TaskItem("第 12~13 周：当代世界与总复习", "全球化、科技发展、国际秩序、历史时间线复盘")
tip = TextCallout("info", "怎么用", "点圆圈勾选，进度条和计数会实时更新。想改大纲直接说，我按你的节奏重排。")
next = Buttons([Button("展开第 1 周", "turn:按这份 13 周的世界历史大纲，给我第 1 周的详细周计划：每天读什么、看什么、做什么笔记", "primary")])
summary = [Note("13 周 7 个阶段", "从文明的诞生到当代世界，前两个阶段已经完成。", ["list", "done"]), Note("可以点着勾", "点圆圈切换完成状态，进度条和计数实时跟着走，不产生模型调用。", ["list"]), Note("下一步", "可以按大纲展开某一周的每日计划。", ["next"])]
`,
  },
  {
    id: 'binary-search',
    title: '二分查找',
    hint: 'Markdown（列表 / 表格 / 引用 / 公式 / 代码围栏）+ 高亮代码块',
    prompt: '讲一下二分查找，给出 Python 实现和复杂度对比',
    bindings: {},
    source: `root = Stack([title, board, next], "column", "l")
title = TextContent("二分查找", "xl-heavy")
board = Grid([idea, impl, cmp], 2)
idea = Card([CardHeader("思路", "每轮砍掉一半"), ideaText])
ideaText = MarkDownRenderer("**前提**：数组已经排好序。\\n\\n1. 取中点 \`mid\`\\n2. 比较 \`a[mid]\` 和目标值\\n3. 丢掉不可能的那一半，重复\\n\\n> 每轮规模减半，最多比较 $\\\\lceil \\\\log_2 (n+1) \\\\rceil$ 次。\\n\\n- [x] 有序数组\\n- [ ] 链表（不能随机访问）")
impl = Card([CardHeader("实现", "Python 迭代版"), code])
code = CodeBlock("def binary_search(a, target):\\n    lo, hi = 0, len(a) - 1\\n    while lo <= hi:\\n        mid = (lo + hi) // 2  # 中点\\n        if a[mid] == target:\\n            return mid\\n        if a[mid] < target:\\n            lo = mid + 1\\n        else:\\n            hi = mid - 1\\n    return -1", "python", "search.py")
cmp = GridItem([Card([CardHeader("复杂度对比"), cmpText])], 2)
cmpText = MarkDownRenderer("| 方法 | 时间 | 空间 |\\n|---|---|---|\\n| 线性扫描 | $O(n)$ | $O(1)$ |\\n| 二分查找 | $O(\\\\log n)$ | $O(1)$ |\\n\\n递推式：\\n\\n$$T(n) = T\\\\left(\\\\tfrac{n}{2}\\\\right) + O(1) \\\\;\\\\Rightarrow\\\\; T(n) = O(\\\\log n)$$\\n\\n其他语言里取中点要防溢出：\\n\\n\`\`\`ts\\nconst mid = lo + ((hi - lo) >> 1); // 不会溢出\\n\`\`\`", "clear")
next = Buttons([Button("讲讲边界写法", "turn:二分查找的左闭右闭和左闭右开两种写法有什么区别？各给一个例子。", "primary")])
summary = [Note("思路", "有序数组上每轮比较中点、丢掉一半。", ["idea"]), Note("实现", "Python 迭代版，找不到返回 -1。", ["code"]), Note("复杂度", "时间 O(log n)，空间 O(1)。", ["cmp"])]
`,
  },
  {
    id: 'media',
    title: '素材预览',
    hint: '视频播放器 + 音频播放条 + 无法播放的兜底',
    prompt: '把这次宣传片用到的素材列出来，视频和音效都能直接预览',
    bindings: {},
    source: `root = Stack([title, intro, board, next], "column", "l")
title = TextContent("宣传片素材", "xl-heavy")
intro = TextContent("视频可以直接播放；音效点左侧按钮试听，右侧切换倍速。", "default", true)
board = Grid([clip, side], 2)
clip = Card([CardHeader("主镜头", "花朵延时 · 5 秒"), Video("https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", "flower.mp4 · CC0")])
side = Stack([sfx, bgm, broken], "column", "m")
sfx = Card([CardHeader("音效"), roar])
roar = Audio("https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3", "恐龙吼叫", "片头 0:02 · CC0")
bgm = Card([CardHeader("配乐", "备选，还没上传"), Audio("https://example.invalid/bgm.mp3", "片尾配乐", "待替换")])
broken = Card([CardHeader("参考片", "链接失效时的样子"), Video("https://example.invalid/ref.mp4", "参考片")])
next = Buttons([Button("出分镜表", "turn:按这些素材出一份 15 秒宣传片分镜表，标出每个镜头用到的视频和音效。", "primary")])
summary = [Note("主镜头", "花朵延时视频，5 秒。", ["clip"]), Note("音效", "片头用恐龙吼叫，配乐还没定。", ["roar", "bgm"]), Note("失效素材", "参考片链接打不开，需要重新给。", ["broken"])]
`,
  },
];

/** 界面上按了「继续对话」之后，模型给出的下一轮回答（演示用） */
export const FOLLOWUP = {
  id: 'followup',
  title: '后续回答',
  hint: '',
  prompt: '',
  bindings: {},
  source: `root = Stack([title, intro, views, actions], "column", "l")
title = TextContent("设计概念：可调反光背心", "xl-heavy")
intro = TextContent("按你选的方向展开。这一轮是新的回答，上一版界面会被这一版替换。", "default", true)
views = Grid([front, strap, night, spec, next], 3)
front = GridItem([AsyncImage("cozy knit dog vest with reflective piping product photo", "4:3", "100%", "正面")], 2)
strap = AsyncImage("adjustable strap buckle detail on dog vest technical drawing", "1:1", "100%", "肩带结构")
night = AsyncImage("reflective stitching night visibility dog vest close up", "3:4", "100%", "夜间反光")
spec = GridItem([Card([CardHeader("结构规格", "按上一轮选择生成"), Table([Col("部件"), Col("做法"), Col("理由")], [["外层", "420D 尼龙 + DWR", "挡小雨、耐剐蹭"], ["内衬", "摇粒绒 180g", "贴身不磨胸毛"], ["肩带", "双点可调扣", "胸围 30-70cm 通用"], ["反光", "3M 反光包边", "夜间 80m 可见"], ["开口", "腹部魔术贴", "单手穿脱"]], true)])], 2)
next = TextCallout("info", "下一步", "可以让我出打版图、给三家代工的报价区间，或者把配色换成低饱和版本。")
actions = Buttons([Button("出打版图", "action:spec_sheet", "primary"), Button("问代工报价", "turn:给这款背心三家代工的报价区间和起订量", "secondary")])
summary = [Note("可调反光背心", "按你选的方向展开：针织外观 + 反光包边 + 双点可调肩带。", ["views"]), Note("结构规格", "外层 420D 尼龙防泼水，内衬摇粒绒，胸围 30–70cm 通用。", ["spec"]), Note("下一步", "可以出打版图、问代工报价，或换低饱和配色。", ["next"])]
`,
};
