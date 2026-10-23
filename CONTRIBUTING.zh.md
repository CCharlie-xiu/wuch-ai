# 参与贡献

[English](CONTRIBUTING.md) | **中文**

## 开始

```bash
bun install
cp .env.example apps/server/.env   # 填 MODEL_KEY_SECRET（≥16 位）
bun run dev                        # http://127.0.0.1:8788
bun run mock                       # 没 Key 时的假上游 http://127.0.0.1:8789/v1
```

需要 [Bun](https://bun.sh) 1.4+。介绍页本地地址：http://127.0.0.1:8788/intro

## 目录

| 路径 | 内容 |
|---|---|
| `apps/web` | 前端（画布、对话、设置） |
| `apps/server` | 本地 Bun 服务 |
| `apps/cloudflare` | Workers + D1 线上版 |
| `packages/ui-dsl` | UI DSL 解析与校验 |
| `packages/catalog` | 组件目录 |
| `packages/compiler` `runtime` `protocol` | 编译、沙箱运行时、协议 |
| `docs/` `DESIGN.md` | 设计文档与介绍页源文件 |

## 提交前

```bash
bun run test            # 冒烟
bun run test:server
bun run test:dsl
bun run test:catalog
bun run typecheck:dsl
```

- 改了哪块就跑哪块；改 `packages/ui-dsl` 必须跑 `test:dsl` 与 `typecheck:dsl`
- 新行为带测试

## 分支与提交

- 从 `main` 切分支：`feat/…`、`fix/…`、`docs/…`
- 提交信息：`类型(范围): 说明`，类型取 `feat` `fix` `chore` `docs` `refactor` `test`
- 一个 PR 做一件事，目标分支 `main`

## 不要提交

`.env`、`*.db`、API Key、`node_modules`。`.env.example` 只放占位。

## Issue

- Bug 和功能建议用 Issue 模板
- 安全问题不要开公开 Issue，见 [SECURITY.zh.md](SECURITY.zh.md)（[English](SECURITY.md)）
