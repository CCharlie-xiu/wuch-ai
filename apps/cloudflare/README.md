# Cloudflare 部署切片

**Workers + D1 + Static Assets**：完整前端上云；**按账号隔离**（小范围邀请制可用）。

本地 Bun（`apps/server`）仍是功能最全的开发环境。

## 线上

**https://wuch-ai.net**（自定义域名）

备用：https://openui-lab.aoci-wuch.workers.dev

## 已支持

| 能力 | 路径 |
|---|---|
| 完整静态前端（聊天 / 登录 / demos） | `/` `/login` `/demos.html` |
| 健康检查 | `GET /api/health` |
| 鉴权（邮箱注册/登录） | `/api/auth/signup` `/signin` `/me` |
| 管理员 | `/api/admin/accounts`（停用/启用；首个注册用户或 `ADMIN_EMAIL`） |
| 会话树（按账号） | `/api/conversations*` |
| 模型配置 | `/api/models*` |
| 联网工具设置与执行 | `/api/tools*` |
| 上游代理（CORS / SSE） | `/proxy?url=…` |
| 跨会话记忆 + Token 计量 | `/api/memory*`、`GET /api/conversations/:id/metrics` |
| 知识库（AOCI） | `/api/kb*` |
| 技能目录 + 会话技能 | `GET /api/skills`、`/api/conversations/:id/skills` |
| 附件正文抽取 | `POST /api/files/extract`（文本 + docx/pptx/odf + PDF；上限 16MB；**不存原件**） |
| 数据集 JSON CRUD | `/api/datasets*`、`GET /api/conversations/:id/datasets` |
| 表格 CSV 导入 | `POST /api/datasets/import?...`（**仅 .csv**） |
| 表格 CSV 导出 | `GET /api/datasets/:id/export?format=csv`、`POST /api/export`（format=csv） |

迁移：

- `0003_memory_kb_skills.sql` — blob、记忆、知识库、skill
- `0004_dataset.sql` — dataset / dataset_version
- `0005_tenant.sql` — 账号角色/停用 + 业务表 `account_id`

可选：`wrangler secret put ADMIN_EMAIL`（逗号分隔）把指定邮箱定为管理员。

## Workers 与本地 Bun 的差异

| 能力 | Workers | 本地 Bun |
|---|---|---|
| 文件抽取上限 | **16MB** | 32MB |
| PDF 抽取 | **unpdf** | pdfjs |
| 原件持久化 | **不做**（只抽正文） | 不落盘 |
| 数据集导入 | **CSV** | xlsx / xls / csv |
| 数据集 / 内联导出 xlsx | **501** | 支持 |
| 数据集导入上限 | **8MB** | 10MB |

xlsx / xls 导入与 xlsx 导出请继续 `bun run dev`，或走 CSV / JSON。

## 仍 stub

`/api/endpoints`、`GET /api/storage` 等占位接口 —— 不挡进主界面。线上不做物料 / 原件存储。

## 本地

```bash
cd apps/cloudflare
bun install
bun run db:migrate:local
bun run dev          # 会先 stage 再 wrangler dev
```

## 部署

```bash
cd apps/cloudflare
bun run db:migrate:remote
bun run deploy       # stage + wrangler deploy
```

## 注意

- 密码：Workers 用 PBKDF2；本地 Bun 用 scrypt。两套库分开。
- `stage-app.mjs` 会把 `ui-dsl` 的 `.ts` 剥成 `.js`，并改写 HTML import map。
- 资产体积较大（字体 / echarts / 组件）；首次上传较慢属正常。

## 下一刀候选

1. xlsx 导入/导出（或仅保留 CSV）
2. `www` 跳转到根域名（可选）
