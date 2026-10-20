# wuch-ai

**说一句你想要的，界面在画布上长出来。**

不用拖控件、不用写前端。右侧对话一句，左侧画布边写边渲染；滑块、勾选和选项就地改，不另调模型。会话、记忆和知识库留在你这边。

**在线试用 → [https://wuch-ai.net](https://wuch-ai.net)** · [演示回放](https://wuch-ai.net/demos.html)（不连模型也能看）

[MIT](LICENSE) · 本地需 [Bun](https://bun.sh) · 线上跑在 Cloudflare Workers

## 长什么样

**登录。** 独立登录页，注册或登录后再进画布；可留多个账号随时切换。

![登录页](docs/images/login.jpg)

**主界面。** 左画布、右对话。右侧说一句，左侧边写边渲染；顶栏可看原文、编译产物、诊断。

![主界面：左侧画布，右侧对话](docs/images/canvas.jpg)

**产品分析仪表盘。** 一句「做产品分析仪表盘」就能长出指标、趋势图和结论卡，对话里继续改。

![产品分析仪表盘](docs/images/dashboard.jpg)

**地图与干线。** 演示回放里不连模型也能看：门店标注、干线、区域高亮，链路与正式聊天相同。

![全国门店与干线地图](docs/images/map.jpg)

**表格与 Excel。** 可编辑的销售明细，支持导入自己的表格，再让对话做达标与预算分析。

![区域销售表与分析](docs/images/excel.jpg)

## 你会用到什么

| 入口 | 做什么 |
|---|---|
| [wuch-ai.net](https://wuch-ai.net) | 在线版：注册登录后直接用 |
| `/login` | 注册或登录后进主界面 |
| `/` | 左侧实时界面，右侧对话；设置里填模型地址与 Key |
| `/demos.html` | 不连模型，预置界面回放（地图、表格等） |

右侧随便说一句（例如「做一页 Q3 销售」），左侧会边写边渲染。界面上的控件可以直接点；需要下一轮时再发消息。

## 跑起来（本地）

```bash
bun install
bun run dev          # http://127.0.0.1:8788
bun run mock         # 可选：没 Key 时用假上游 http://127.0.0.1:8789/v1
```

1. 打开 http://127.0.0.1:8788/login ，注册一个账号  
2. 进主界面后打开设置，填 OpenAI 兼容的接口地址与 Key  
3. 官方 API 一般有 CORS：在设置里改成本地转发，或把地址写成  
   `http://127.0.0.1:8788/proxy?url=https://api.openai.com/v1`  
4. 没有 Key：先 `bun run mock`，接口填 `http://127.0.0.1:8789/v1`  
5. 想先看效果：打开 `/demos.html`，点地图或表格类演示

线上版见 [https://wuch-ai.net](https://wuch-ai.net)。Cloudflare 部署说明在 [`apps/cloudflare/README.md`](apps/cloudflare/README.md)。

## 还能做什么

- 多个模型、多个接口，输入框右下角切换  
- 图片、表格、文档随对话带进来  
- 知识在对话里蒸馏成条目，之后按索引再取  
- 工具有预算；上下文快满时可压缩，当前界面原文保留  
- 顶栏检视器看更新、诊断与操作  

更细的设计与实现说明在 `DESIGN.md`、`DESIGN-KB.md`、`docs/`，用的时候不必先读。
