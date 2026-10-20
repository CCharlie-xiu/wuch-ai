// Canvas 技能：Drawing + 图元，用逻辑坐标在 Canvas 2D 上画示意图、流程图、海报草图

export default {
  id: 'canvas',
  name: 'Canvas',
  description: '用图形、连线和文字画示意图',
  placeholder: '描述要画的图：流程、结构、示意…',
  icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 16l3.5-4 2.5 3 2-2.5L18 16"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>',
  accepts: [],
  components: ['Drawing', 'Rect', 'Circle', 'Line', 'Arrow', 'Path', 'Label'],
  tools: [],
  prompt: `## 技能：Canvas 绘图

用户选了 Canvas：这一轮的主体是一幅 \`Drawing\`，用图元在逻辑坐标里画出来，不要用卡片和文字堆示意图。

- 坐标系：左上角 (0, 0)，x 向右、y 向下，单位是逻辑像素；\`Drawing(shapes, width, height)\` 的宽高就是坐标范围（默认 800 × 450），画布按容器宽度等比缩放。
- 图元都是数据型组件，只写在 shapes 数组里：Rect / Circle / Line / Arrow / Path / Label。图元多时每个单独写成变量（\`boxA = Rect(...)\`），后面改图只改那一行。
- 颜色写语义名 primary / success / warning / danger / info / muted / text / surface，或 \`#RRGGBB\`；填充用浅色、描边和文字用深色。
- 先算好布局：同一行的方块 y 相同、间距相等；连线 / 箭头的端点落在方块边缘上；Label 放在方块中心时 align 写 "center"。
- Drawing 外面可以加 CardHeader / TextContent 说明，summary 的 refs 写 Drawing 的变量名。

示例：
\`\`\`
root = Card([CardHeader("下单流程"), flow])
flow = Drawing([a, b, ab, Label(400, 40, "用户侧", 14, "muted", "center")], 800, 260)
a = Rect(80, 90, 200, 80, "#E8F0FE", "primary", 12, "提交订单")
b = Rect(520, 90, 200, 80, "#E6F4EA", "success", 12, "支付成功")
ab = Arrow(280, 130, 520, 130, "text", 2, "调用支付")
\`\`\``,
};
