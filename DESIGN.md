# wuch-ai · 结构调整与数据层设计方案

> 状态：待执行 · 目标版本 `0.3.0`
>
> 本文覆盖三件事：把项目拆成前后端分开的 monorepo、让前后端独立稳定跑起来、
> 加一个真正的数据库填上 `appData` 那两个空壳。不改变 DIL / 编译 / 沙箱 / 渲染这条主链路。

## 修订记录

| 日期 | 变更 | 依据 |
|---|---|---|
| 初版 | Node + pnpm workspaces + Vite 方案 | 源码与 MCP 实测 |
| 本次 | 运行时改为 **Bun + TypeScript**（§1.1、§1.5）；补记 **DIL 位置参数与赋值式语法**的发现（§10）；React 范围记为未决（§9、§11.1） | 本机实测 + 源码比对 |
| **P1 完成** | workspace 结构落地，实施结果与两处有意偏差记入 **§2.3** | `bun install` + 94 断言 + 浏览器端到端 |
| **DSL 阶段 1 完成** | 新增 `packages/ui-dsl`（解析 + 两阶段引用解析 + 校验 + 规范化 AST），规范记入 **§12** | 64 条 DSL 测试 + typecheck + 原有测试逐字节不回归 |
| **DSL 实参绑定** | 增补 `bind.ts`：实参按类型对齐、可选参数可跳过（不必写 `null` 占位），含两条防静默误绑的守卫；§12.2 / §12.5 / §12.6 同步更新；§10 的三处 ⚠️ 标记为已解决 | 78 条测试 + typecheck |
| **OpenUI Lang 取代 DIL** | 模型输出改为函数式 OpenUI Lang，`dil.js` 删除；组件拆成一文件一个，注册表改为从目录派生；新增流式宽容分析。见 **§14**（§12.6 / §12.7 的部分结论被取代） | 91 条 DSL 测试 + 91 条端到端断言 + 浏览器五个演示 |

---

## 0. 目标

| # | 目标 | 可验证形式 |
|---|---|---|
| G1 | 项目结构梳理清楚 | 目录边界与依赖声明一致，`bun test/smoke.mjs` 通过 |
| G2 | 前后端分开且稳定跑起来 | `/healthz` 全绿；刷新页面会话从服务端恢复 |
| G3 | 数据库有东西 | `bun run db:reset` 后 API 返回真实查询结果，而不是 `js/demo.js` 的硬编码 |
| G4 | 边界由工具强制，而非靠自觉 | `apps/web` 物理上 import 不到编译器 |

**明确不做**：不重写 DIL 语法、不改操作协议、不换运行时（仍 Node）、不引入 Go。

---

## 1. 现状基线（实测，非推断）

### 1.1 环境

| 项 | 状态 | 验证方式 |
|---|---|---|
| Node | `v26.10.0` | `node --version` |
| **Bun** | ✅ **1.4.3 已安装**（经 `npm i -g bun`；官方 curl 脚本卡在 GitHub） | `bun --version` |
| `node:sqlite` | ✅ 可用（`DatabaseSync` / `StatementSync` / `Session` / `constants` / `backup`） | 实测建表+读写通过 |
| Node 26 原生 TS | ✅ **无 flag 直接跑 `.ts`**（类型擦除，实测 `.ts` + `node:sqlite` 合跑通过） | `node tstest.ts` |
| pnpm | ❌ 未安装（**本方案已改为 Bun，不再需要**） | — |
| Go / Deno | ❌ 未安装（不引入 Go，理由见 §11） | — |
| git | ❌ **本项目不是 git 仓库** | `git rev-parse` 返回非仓库 |
| 本机数据库服务 | ❌ 无 postgres / mysqld / mongod / redis | 进程扫描 |
| 项目内库文件 | ❌ 无 `.db` / `.sqlite` / `.sql` | 文件扫描 |

### 1.2 DBX

| 项 | 状态 |
|---|---|
| DBX MCP | ✅ 已安装并**正在运行**：`~/.dbx/bin/dbx-mcp` |
| 当前客户端加载 | ✅ Cursor 已加载，工具名前缀 `dbx_`，`namespaceStatus: ready` |
| DBX 桌面端 | ⚠️ 未见运行（`dbx_open_table` / `dbx_execute_and_show` 需要它） |
| 已有连接 | ① `dbx-aoci-auth-readonly`（Cloudflare D1，只读）<br>② `kf-test`（MySQL，阿里云 RDS） |
| 工具面涉及的类型 | MySQL / Redis / MongoDB / Salesforce / Cloudflare D1 —— **未见 SQLite** |

**三态判定：`READY`。** 不需要安装动作，直接使用 MCP 工具。
「DBX 是否支持 SQLite」为未决项（见 §9），但**不阻塞本方案**：DBX 不在运行时路径上。

### 1.3 依赖图（由源码 import 实测得出）

```text
catalog.js      ← 无内部依赖                      【唯一真相源】
protocol.js     ← 无内部依赖
demo.js         ← 无内部依赖                      【双端共享：mock 与演示页都要】

dil.js          ← catalog
compile.js      ← catalog
server.js       ← dil, compile                    【编译编排：前后端分离的那条缝】
renderer.js     ← catalog, protocol
model.js        ← catalog
session.js      ← server.js, renderer.js, protocol, model.js   【同时持有渲染器与编译器】
chat.js         ← session, inspector, model
demos.js        ← session, inspector, demo
inspector.js    ← protocol
mock-model.mjs  ← demo.js
server.mjs      ← 仅 node 内建
```

### 1.4 两个"不是模块的资产"

这两处决定了目录安排，必须先认清：

1. **`js/worker-runtime.js` 是资产，不是模块。**
   `js/session.js:144` 用 `fetch('js/worker-runtime.js')` 取**源码文本**，交给 `runner.html` 包进 Blob 再 `new Worker(url)`（`runner.html:48`）。
   `test/smoke.mjs:17` 也按磁盘路径读它，塞进 `node:vm` 跑。
   → 它**绝不能进打包器**（进模块图就会不被产出/被改哈希名，`fetch` 立刻 404），
     且必须位于**发布后可寻址的固定路径**。

2. **`runner.html` 是资产。** 它是 iframe 的 `src`（`index.html` 末尾）。同理不打包。

这不是将就，是设计本意：运行时源码被当作**数据**处理——下载 → 变形 → 在 lockdown 下求值。

### 1.5 Bun 兼容性实测（3/3 通过）

在 Bun 1.4.3 上实测，**未改任何代码**：

| 测试 | 覆盖的 Node API | 结果 |
|---|---|---|
| `bun test/smoke.mjs` | `node:vm`（跑 `worker-runtime.js`）、`node:fs` | ✅ **全部通过**（含 lockdown、操作编码往返、状态跨重编译存活、prompt 生成） |
| 静态服务 | `node:http`、`node:fs` | ✅ `/` 200 6944B · `/js/worker-runtime.js` 200 19271B · `/runner.html` 200 4159B · `/css/app.css` 200 31507B |
| `/proxy` SSE 透传 | `node:http` 流式 | ✅ `Content-Type: text/event-stream` · `Transfer-Encoding: chunked` · CORS 头齐全 · DIL 流式到达，日志无报错 |

Bun 官方兼容表对本项目所需模块的等级：`node:http` 🟢 / `node:fs` 🟢 / `node:vm` 🟢 / `node:sqlite` 🟢；
标 🟡 的 `node:worker_threads` 与 `node:test` **本项目都不用**（沙箱 worker 是浏览器的 Worker；测试用自建的 `smoke.mjs`）。

> 注意：`node:sqlite` 与原生 TS 都**不是 Bun 独有的优势**——Node 26 两者都有（见 §1.1）。
> 选 Bun 的理由是工具链统一与 `bun build --compile` 单二进制，不是这两项。

---

## 2. 目标结构

```text
openui-lab/
├── package.json                    # private + workspaces + 根脚本
├── bunfig.toml                     # [install] linker = "isolated"（拒绝幽灵依赖）
├── README.md
├── DESIGN.md                       # 本文
│
├── apps/
│   ├── web/                        # 静态站；依赖里没有 compiler
│   │   ├── package.json
│   │   ├── index.html · demos.html
│   │   ├── public/
│   │   │   └── runner.html         # 静态资产，不进打包器
│   │   ├── css/app.css
│   │   └── src/
│   │       ├── session.js          # 改写：从「同页调编译器」→「消费 SSE patch」
│   │       ├── renderer.js · inspector.js · chat.js · demos.js · model.js
│   └── server/                     # Node 服务：编译 + 数据 + 转发
│       ├── package.json
│       ├── index.mjs               # ← server.mjs
│       ├── src/compile-session.mjs # ← js/server.js
│       ├── src/db.mjs              # node:sqlite 连接、迁移、查询
│       ├── src/resolvers/          # 数据源 adapter（见 §5）
│       ├── data/schema.sql
│       ├── data/seed.mjs
│       ├── data/openui.db          # 运行时生成，.gitignore
│       └── mock.mjs                # ← mock-model.mjs
│
├── packages/
│   ├── catalog/                    # 唯一真相源，双端共享
│   │   └── src/index.js            # ← js/catalog.js
│   ├── protocol/                   # 操作编解码，双端共享
│   │   └── src/index.js            # ← js/protocol.js
│   ├── fixtures/                   # 预置 DIL 与跟随数据，双端共享
│   │   └── src/index.js            # ← js/demo.js
│   ├── compiler/                   # 只有 apps/server 能依赖
│   │   └── src/{dil.js,compile.js}
│   └── runtime/                    # 以「源码资产」形式被消费，禁止打包
│       └── src/worker-runtime.js    # ← js/worker-runtime.js
│
└── test/
    └── smoke.mjs                   # 跨包集成测试，留在根
```

### 2.1 包名与依赖声明

包名统一 `@openui-lab/*`。

```json
// apps/web/package.json
{
  "name": "@openui-lab/web",
  "dependencies": {
    "@openui-lab/catalog":  "workspace:*",
    "@openui-lab/protocol": "workspace:*",
    "@openui-lab/fixtures": "workspace:*"
  }
}

// apps/server/package.json
{
  "name": "@openui-lab/server",
  "dependencies": {
    "@openui-lab/catalog":  "workspace:*",
    "@openui-lab/protocol": "workspace:*",
    "@openui-lab/fixtures": "workspace:*",
    "@openui-lab/compiler": "workspace:*",
    "@openui-lab/runtime":  "workspace:*"
  }
}
```

**`apps/web` 不声明 `@openui-lab/compiler`。** Bun 的 isolated 链接会拒绝幽灵依赖，
于是"前端拿不到编译器"不再靠自觉，而是链接器拒绝——这是 G4 的实现方式，
也是 README 里"页面就再也拿不到编译器，CSP 可以收紧到真正的 `default-src 'none'`"终于成立的条件。

### 2.2 逐文件去向

| 现在 | 去向 |
|---|---|
| `js/catalog.js` | `packages/catalog/src/index.js` |
| `js/protocol.js` | `packages/protocol/src/index.js` |
| `js/demo.js` | `packages/fixtures/src/index.js` |
| `js/dil.js` | `packages/compiler/src/dil.js` |
| `js/compile.js` | `packages/compiler/src/compile.js` |
| `js/worker-runtime.js` | `packages/runtime/src/worker-runtime.js` |
| `js/server.js` | `apps/server/src/compile-session.mjs`（改 SSE 化） |
| `js/session.js` | `apps/web/src/session.js`（改写为 patch 消费者） |
| `js/renderer.js` | `apps/web/src/renderer.js` |
| `js/inspector.js` | `apps/web/src/inspector.js` |
| `js/model.js` | `apps/web/src/model.js` |
| `js/chat.js` | `apps/web/src/chat.js` |
| `js/demos.js` | `apps/web/src/demos.js` |
| `server.mjs` | `apps/server/index.mjs` |
| `mock-model.mjs` | `apps/server/mock.mjs` |
| `index.html` / `demos.html` | `apps/web/` |
| `runner.html` | `apps/web/public/runner.html` |
| `css/app.css` | `apps/web/css/app.css` |
| `test/smoke.mjs` | 留在 `test/`（跨 catalog 与 web 的不变量，属集成测试） |

`test/smoke.mjs` 内部按路径读文件的几处（如读 `worker-runtime.js`）需同步更新。

### 2.3 实施结果（P1 已完成）

以下结构已经落地，与 §2 的**目标**结构有两处有意偏差（都是"现在还没到那一步"）：

```text
openui-lab/
├── package.json                 # workspaces + 根脚本 + 测试套件的依赖声明
├── bunfig.toml                  # [install] linker = "isolated"
├── README.md · DESIGN.md
├── apps/
│   ├── web/
│   │   ├── package.json         # deps: catalog compiler fixtures protocol
│   │   ├── index.html · demos.html   # 各含一份 import map
│   │   ├── public/runner.html
│   │   ├── css/app.css
│   │   └── src/                 session · compile-session · renderer · inspector
│   │                            · chat · demos · model
│   └── server/
│       ├── package.json         # deps: fixtures runtime
│       ├── index.mjs            # 显式路由表（EXACT / PREFIXES）+ /proxy
│       └── mock.mjs
├── packages/
│   ├── catalog/  · protocol/  · fixtures/   各 src/index.js
│   ├── compiler/  src/{dil.js,compile.js}
│   └── runtime/   src/worker-runtime.js
└── tests/smoke.mjs              # 跨包集成测试
```

**偏差一：`compile-session.js` 留在 `apps/web/src/`，没有进 `apps/server/src/`。**
它在**今天**是浏览器侧模块 —— 编译循环、`appData` 组装、240ms 重编译全在页面里跑
（那是 §1.3 依赖图里 `session.js → server.js → dil/compile` 这条链）。
放进 `apps/server` 会与"依赖声明反映现实"的原则冲突，也会让 `apps/web` 反过来依赖服务端实现。
**P3 做 SSE 解耦时搬走**，那才是它真正的归属。

**偏差二：`apps/server/data/`（schema / seed / db.mjs / resolvers）尚未创建。** 属 P2。

**P1 的三个决策（需你确认）**

| 决策 | 选择 | 理由 |
|---|---|---|
| 浏览器如何解析 `@openui-lab/*` | **import map**（写在两个 HTML 里） | 浏览器原生支持，**不需要打包器**，保住"零构建步骤"；映射表本身就是该页的依赖清单，没列进去的包页面拿不到。备选是相对路径 `../../packages/...`（会跨越 app 边界）或现在就上打包器（与零构建冲突） |
| 依赖声明 | **只声明当前真正用到的** | `apps/server` 只声明 `fixtures` + `runtime`，没提前声明 `compiler`——否则依赖图说谎。P2/P3 用到时再加 |
| 测试放哪 | `tests/`（根），依赖写在**根** `package.json` | `tests/` 不是 workspace 成员，根 `node_modules` 不会自动链接 workspace 包；把它的依赖声明在根上，使"测试消费哪些包"成为显式契约 |

**两处"约定路径"的兼容映射**（对应 §1.4 的资产约束，写法在 `apps/server/index.mjs`）：

| URL | 物理位置 | 调用端 |
|---|---|---|
| `/runner.html` | `apps/web/public/runner.html` | `apps/web/src/session.js` 的 `runnerFrame.src` —— **未改动** |
| `/js/worker-runtime.js` | `packages/runtime/src/worker-runtime.js`（经 `import.meta.resolve` 解析） | `apps/web/src/session.js` 的 `fetch` —— **未改动** |

URL 是契约，物理位置是内部实现；搬文件不动契约。

**P1 验收结果**

| 检查 | 结果 |
|---|---|
| `bun install` | ✅ 14 个链接 / 8 个包，isolated linker 生效 |
| 模块边界 | ✅ `apps/web` 解析不到 `runtime`；`apps/server` 解析不到 `compiler`（`node_modules` 布局实证） |
| `bun run test` | ✅ **94 条断言全通过，输出与迁移前逐字节一致** |
| 六个页面/资源 URL | ✅ 全 200 |
| 两条约定路径 | ✅ 全 200（物理文件已搬走） |
| import map 目标 | ✅ 5 个模块全 200 |
| 目录穿越防护 | ✅ `/packages/../../package.json` → 404 |
| `/proxy` SSE 透传 | ✅ `text/event-stream` 流式到达，无报错 |
| **浏览器端到端** | ✅ 演示页跑通：舞台渲染出 `$232/mo`、`操作 29（create 27 / set 2）`、`程序 1770 字节 · 常量表 399 字节 · 元素 13 个`、lockdown `已移除 31 个全局能力` —— **与迁移前基线数字完全一致** |
| 未夹带 | ✅ DIL 语法、操作协议、沙箱边界、组件语义、数据库、SSE 均未改动 |

---

## 3. 前后端接口契约

### 3.1 关键发现：契约已经存在

`js/server.js` 早就在产出 `{ p, o, v }` 形状——标准 JSON-Patch：

```js
// js/server.js:195（现状）
p: '/message/metadata/model_dil_v2/appData/opGenui/componentResults',
o: 'replace',
v: results
```

所以前后端分离**不需要发明新协议**，只需换投递方式：

```text
现在：  compile 循环 ──emitPatch()──▶ 同页函数调用
之后：  compile 循环 ──emitPatch()──▶ SSE ──▶ 前端 session.js 消费
```

### 3.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/turn` | 开一轮。body `{ sessionId, prompt }` → `{ turnId }` |
| `GET` | `/api/turn/:id/stream` | SSE 事件流，见下表 |
| `POST` | `/api/turn/:id/action` | 交互动作回流（`GenUI.copy` / `openUrl` 这类需要宿主办的事） |
| `GET` | `/api/session/:id` | 会话与轮次回读（刷新页面恢复用） |
| `GET` | `/healthz` | `{ ok, db, compiler, version }` |
| `GET` | `/runtime/worker-runtime.js` | **运行时源码**：由 `apps/server` 从 `packages/runtime` 直接读文件返回 |
| `GET` | `/runner.html` | 沙箱宿主页 |
| `ALL` | `/proxy?url=…` | 保留现有的上游转发（含 SSE 透传与 CORS 补头） |

`/runtime/worker-runtime.js` 由服务端直接读文件提供，而不是走打包器——
这样 dev 与 prod 行为一致，且保住"零构建"这条主线（§1.4 的约束）。

### 3.3 SSE 事件

| 事件 | 载荷 | 对应现有代码 |
|---|---|---|
| `ready` | `{ turnId }` | — |
| `patch` | `[{ p, o, v }, …]` | 复用 `emitPatch` 的产出，形状不变 |
| `diagnostics` | 恢复诊断 + 目录校验诊断 | `dil.js` 的 `RECOVERY` 三类 + `compile.js` 的 `unknown_prop` 等 |
| `server-requests` | `[{ id, componentName, query }]` | `out.serverRequests` |
| `done` | `{ stats }` | 三类更新统计（结构变了 / 只有文字长了 / 在没写完的标签里） |
| `error` | `{ kind, message }` | — |

`patch` 的 `p` 路径保持 `model_dil_v2` 前缀不变，前端检视器（`inspector.js` 的七个面板）不用改。

---

## 4. 数据库设计

### 4.1 设计出发点：填两个已经存在的空壳

`appData` 的形状是钉死的：

```js
// js/compile.js:406
const appData = { opGenui: { componentResults: {}, modelDataBindings: {} } };
```

| 空壳 | 现状来源 | 应变为 |
|---|---|---|
| `modelDataBindings` | `js/demo.js:80` 硬编码 `turn448791product0: {...}` | 按轮次从库里查出的真实实体 |
| `componentResults` | `js/server.js:52` `resolveImageRequest` → picsum 占位图 | resolver 查询/取图结果，带缓存 |
| 触发解析的组件 | `catalog.js:292` `SERVER_RESOLVED = {AsyncImage, AsyncImageGroup, Entity, EntityList, Cite}` | 不变 |

**顺带，这也是安全主线的落地点**：DIL 里写的是 `{turn448791product0.displayed_price}` 这种**引用**，
模型从头到尾看不到数据本身。数据库在这里的角色不是"给项目加个库"，而是
让"模型只写引用、服务端注入值"这条隔离有真实来源。

### 4.2 Schema

```sql
-- ① 会话层：让"后端持有状态"成立（现在全在内存 + localStorage）
CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turn (
  id          TEXT PRIMARY KEY,                 -- 形如 turn448791
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  prompt      TEXT,
  dil         TEXT,                             -- DIL 原文：可回放、可重编译
  state       TEXT NOT NULL,                     -- streaming | complete | error
  diagnostics TEXT,                             -- JSON：编译诊断快照
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

-- ② 别名映射：解释 key 为什么长成 turn448791product0
CREATE TABLE IF NOT EXISTS turn_binding (
  turn_id   TEXT NOT NULL REFERENCES turn(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL,                      -- "product0"
  entity    TEXT NOT NULL,                      -- "product"
  entity_id TEXT NOT NULL,                      -- 指向域数据层
  PRIMARY KEY (turn_id, alias)
);

-- ③ 域数据层：填 modelDataBindings
CREATE TABLE IF NOT EXISTS product (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  merchant        TEXT,
  displayed_price TEXT NOT NULL,
  currency        TEXT DEFAULT 'CNY',
  image_id        TEXT REFERENCES media_asset(id)
);

-- ④ 解析层：填 componentResults + 给检视器「诊断」面板供料
CREATE TABLE IF NOT EXISTS media_asset (
  id          TEXT PRIMARY KEY,                 -- 编译期那个"跨重编译稳定的 id"
  query       TEXT,
  content_url TEXT,
  width       INTEGER,
  height      INTEGER,
  fetched_at  INTEGER,
  source      TEXT                              -- online | placeholder | seed
);

CREATE TABLE IF NOT EXISTS resolution_log (
  turn_id        TEXT NOT NULL REFERENCES turn(id) ON DELETE CASCADE,
  request_id     TEXT NOT NULL,
  component_name TEXT NOT NULL,
  query          TEXT,
  status         TEXT NOT NULL,                 -- ok | miss | error
  ms             INTEGER,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (turn_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_turn_session ON turn(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_resolution_turn ON resolution_log(turn_id);
```

`media_asset.id` 对应 `compile.js:223` 那个"给服务端解析的组件生成跨重编译稳定 id"，
两者是同一个东西——这样重复编译不会重复取图。

### 4.3 一条明确的"不做"

**`catalog` 不落库。** 它必须与 `renderer.js` 同步发版（`test/smoke.mjs` 的三条不变量钉着这个关系），
落库会把"唯一真相源"从代码搬到数据库，换来可查询性却引入同步漂移——性价比不成立。
同理 `protocol.js` 的 opcode 表也不落库。

---

## 5. 数据源 adapter（resolver 抽象）

默认实现走 SQLite；接口留出替换空间，使日后改用 MySQL（即让 DBX 原生可看）只换一个文件。

```text
apps/server/src/resolvers/
├── index.mjs         # 选 adapter、拼 appData、写 resolution_log
├── sqlite.mjs        # 默认：node:sqlite
├── memory.mjs        # 退回 fixtures 的假数据（无库也能跑 / 单测用）
└── media.mjs         # 现有 resolveImageRequest 的在线取图，带 media_asset 缓存
```

接口形状：

```js
// DataSource（adapter 必须实现）
{
  findEntity(kind, id),                 // → 域数据行 | null
  listEntities(kind, { limit }),        // → 行数组
  bindingsForTurn(turnId),              // → { alias: {…} }  填 modelDataBindings
  resolveMedia(request),                // → { id, content_url, … }  填 componentResults
  logResolution(entry),                 // → 审计
  // 会话层
  getSession(id), putTurn(turn), getTurn(id), appendTurn(turn),
}
```

选择开关：环境变量 `OPENUI_DATASOURCE=sqlite|memory`，默认 `sqlite`，测试与演示回放可用 `memory`。
`memory.mjs` 的存在保证了一件事：**没有数据库时项目仍能完整跑通**（这也是 `test/smoke.mjs` 现在依赖的形态）。

---

## 6. 稳定运行的验收标准

"稳定跑起来"落成四条可执行检查：

1. `curl -s localhost:8788/healthz` → `{"ok":true,"db":"ready","compiler":"ready"}`
2. 前端刷新页面，会话与界面从服务端恢复（证明后端持有状态）
3. `rg -i 'dil|compile' apps/web/src` 查不到编译器引用（边界由 Bun 强制）
4. `bun run db:reset` 幂等：反复执行后数据回到同一已知状态

根脚本：

```json
{
  "scripts": {
    "dev":        "bun run --filter '*' dev",
    "dev:server": "bun run --filter @openui-lab/server dev",
    "dev:web":    "bun run --filter @openui-lab/web dev",
    "db:reset":   "bun run --filter @openui-lab/server db:reset",
    "db:inspect": "bun run --filter @openui-lab/server db:inspect",
    "mock":       "bun run --filter @openui-lab/server mock",
    "test":       "bun test/smoke.mjs"
  }
}
```

`db:inspect` 是在 DBX 不支持 SQLite 时的兜底观察窗（输出表清单、每表行数、最近若干轮次）。

---

## 7. 分阶段执行

| 阶段 | 内容 | 验收 | 风险 |
|---|---|---|---|
| **P0** | `git init` + 首次提交当前状态，作为回退基线 | `git log` 有基线提交 | 无。**P1 前必须完成** |
| **P1** ✅ | 建 workspace（`bunfig.toml` + 各包 `package.json`）；按 §2.2 移文件；改 import 路径；两条约定路径做兼容映射 | **已完成**，见 §2.3：`bun install` 通过 · 94 条断言全绿且与迁移前逐字节一致 · 浏览器端到端数字与基线吻合 | 低（纯搬运，无行为改动） |
| **P2** | 加 `db.mjs` + `schema.sql` + `seed.mjs`；实现 `sqlite.mjs` 与 `memory.mjs`；`compile-session` 的 bindings/resolver 从 `fixtures` 硬编码切到 adapter | `bun run db:reset` 后 API 返回库中数据；`OPENUI_DATASOURCE=memory` 仍可跑 | 低-中 |
| **P3** | `compile-session` 改 SSE 化；`apps/web/src/session.js` 改写为 patch 消费者；前端移除编译器入口；补 `/healthz`、`/api/session/:id` | §6 四条全过 | **中**。本方案唯一有真实改造量的阶段 |
| **P4**（可选） | 接 Vite：dev 用原生 ESM 保住"零构建"手感；`public/` 与 `packages/runtime` 明确排除 | 静态站可发布 | 低-中 |

**P1 做完结构就定了；P3 是唯一需要仔细设计的一步。** P4 之前不引入打包器——
`apps/server` 现有静态文件服务已足够支撑 dev。

---

## 8. 风险与注意

| 风险 | 处置 |
|---|---|
| **项目无 git，P1 移动 22 个文件不可回退** | P0 先建基线提交 |
| `worker-runtime.js` 被误纳入打包/模块图 → 运行时 404 | 它只被 `fetch` 与 `node:vm` 读，永不 import；放在 `packages/runtime` 且声明为资产；§3.2 由服务端读文件提供 |
| `test/smoke.mjs` 内按路径读文件的几处会随搬迁失效 | P1 内同步更新，以它作为搬迁是否完整的判据 |
| 前后端分离后出现"半截流"跨进程问题（编译循环在服务端、patch 在前端应用） | 复用现有三类更新判定；`patch` 事件幂等；SSE 断线用 `GET /api/session/:id` 全量恢复 |
| SSE 端点无鉴权 | 当前定位本地单用户 lab，可接受；**若对外暴露必须先加鉴权与会话绑定**，并在 README 注明 |
| SQLite 并发写（WAL 之外） | 单写者语义即可；开启 `PRAGMA journal_mode=WAL` 与 `busy_timeout` |
| Bun 的 isolated 链接与个别工具不兼容 | 本仓库零第三方运行时依赖，风险面极小；必要时 `bunfig.toml` 里设 `linker = "hoisted"` 单点回退 |

---

## 9. 未决项

1. **React 的范围。** 读到模型返回的实物（DIL → 编译程序 → 27 个操作 → 276 字节二进制）后可见：
   模型输出与渲染之间隔了三跳，**React 在物理上只能接最后一跳**。
   - 方案 A：React 只做壳（聊天 + 七个检视面板，替换 616 行），舞台保留 `renderer.js` + `protocol.js`；
   - 方案 B：React 接管舞台，等于删掉 `renderer.js` + `protocol.js` 共 1544 行——即 README 列为"本项目自定"的核心资产。
   倾向 A。**未定。**
2. **DIL 是否换成赋值式语法**（见 §10）。**未定。**
3. **DBX 是否支持打开 SQLite。** 工具面只提到 MySQL / Redis / MongoDB / Salesforce / Cloudflare D1。不阻塞本方案（DBX 不在运行时路径上）；若支持，则加一个连接指向 `apps/server/data/openui.db`；若不支持，用 `bun run db:inspect`。验证需要在 DBX 中新增一个连接（会改动用户 DBX 配置，需先确认）。
4. **DBX 桌面端未运行**，`dbx_open_table` / `dbx_execute_and_show` 暂不可用。
5. **P4 是否接 Vite**，等 P3 完成后再定。若上 React 则必须接（见 §11.1）。
6. `componentResults` 的缓存粒度与失效策略（`media_asset` 已具备跨重编译复用的基础，具体 TTL 未定）。
7. 是否支持多会话/多客户端并存（当前会话层表结构已支持，接口未定）。
8. **应用级 TypeScript 化的范围**：TS 只能约束协议信封（SSE 事件、patch 形状、adapter 接口）；
   沙箱里跑的编译产物是运行期生成的字符串、经 `new Function` 求值，**本质无类型**，TS 覆盖不到。

---

## 10. DIL 语法：位置参数与赋值式（新发现）

### 10.1 目录早已声明了位置参数，但解析器没实现

`catalog.js` 头部已写明这个格式：

```js
// 组件名与参数顺序对齐 OpenUI 内置库（@openuidev/react-ui），
// 位置参数 → 具名 props 的映射由编译器完成。
```

但实测：`dil.js` 的 `scanTagHead`（108–182 行）**只认 `name="…"` / `name={expr}` / 裸 flag**，
`compile.js` 里 grep 不到任何 positional 实现，`array` 参数类型（`rules` / `options`）也无编译支持。

即：**catalog 是照位置参数设计的，解析器与编译器欠了这一层。**

### 10.2 现有目录与位置参数的逐条比对

| 位置式写法 | catalog 声明的参数顺序 | |
|---|---|---|
| `Stack([a,b], "column", "l")` | `[children, direction, gap, …]` | ✅ |
| `Form("contact", [fields], buttons)` | `[id, fields, buttons]` | ✅ |
| `FormControl("Name", Input(…))` | `[label, control, hint]` | ✅ |
| `SelectItem("general", "General inquiry")` | `[value, label]` | ✅ |
| `Buttons([a,b], "row")` | `[children, direction]` | ✅ |
| `Button("Submit", "submit:contact", "primary")` | `[label, action, variant, …]` | ✅ |
| `TextContent("Contact Us", "large-heavy")` | `[text, style, muted]` | ✅ |
| `Input("name","…","text",["required"])` | `[name, placeholder, type, **value**, **rules**]` | ⚠️ |
| `TextArea("message","…",6,[…])` | `[name, placeholder, rows, **value**, **rules**]` | ⚠️ |
| `Select("subject",opts,"…",[…])` | `[name, options, placeholder, **value**, **rules**]` | ⚠️ |

三处 ⚠️ 同一成因：`value` 排在 `rules` 之前，跳过 `value` 只传校验数组会落到 `value` 槽位。

> **已在 DSL v1 解决**：`packages/ui-dsl` 的实参绑定按类型对齐，可选参数可以跳过，
> 所以 `Input("name","…","text",["required"])` 这种写法是对的（见 §12.5）。
> 本节保留的是当时对 **DIL 那条链路**的观察 —— DIL 至今只支持具名属性，没有实现位置参数。
`rules` 本身**已有槽位**（`p('rules','array')`），缺的是 `array` 类型的编译支持。

### 10.3 两种语法：嵌套标签 vs 赋值式绑定表

| | 现状：嵌套标签 | 备选：赋值式绑定表 |
|---|---|---|
| 结构 | `<Stack><Slider/><Text/></Stack>` | `root = Stack([a, b], …)` 逐行 |
| 子节点 | 靠嵌套位置 | 靠**前面定义的变量名** |
| 闭合 | 需要 `</Stack>` | **不需要**，每行自足 |
| 状态 | `{@body const [n,setN]=DIL.useState(3)}` | `seats = useState(8)` |
| 控制流 | `{#if}` / `{#each}` | `items = steps.map(…)` / 三元 |
| 半截输入 | 靠恢复诊断（`unterminated_tag` 等三类） | **天然免疫**——每行原子，未完成行直接丢 |
| 跨重编译状态 | 需显式 `{ key: "seats" }` | **白拿**——变量名即稳定 key |
| 散文同源 | Markdown 与组件**编进同一棵树** | **需专门设计**（唯一破口） |

赋值式三赢：**半截输入问题基本消失**（也是 README 给 DIL 定的第一要求）、**稳定 key 白拿**、
**语法反而变少**（`{@body}`/`{#if}`/`{#each}` 三种特例记号退化成普通 JS）。

代价：`root` 引用后面的行，是**前向引用**，编译需两趟绑定解析；
`app_block` 的原始 HTML/CSS/JS 需要单独形式；`dil.js` 662 行需按新语法重写。

### 10.4 待补清单（若采纳）

| 要补 | 位置 | 现状 |
|---|---|---|
| 位置参数解析 | `dil.js` `scanTagHead` | 无 |
| 位置 → 具名映射 | `compile.js` `emitNode` | 无 |
| `array` 参数类型 | `compile.js` | 无 |
| 两趟绑定解析（前向引用） | `compile.js` | 无 |
| 散文同源方案 | `dil.js` + `compile.js` | 需新设计 |
| `subjectOptions` 这类**命名值绑定** | `dil.js` | 无 |
| 6 条演示改写 + `smoke.mjs` 断言重写 + 提示词更新 | `demo.js` / `test` / `catalog.js` | — |

---

## 11. 决策记录：为什么不改后端为 Go

用户提案为 Go 后端，**评估后不采纳**，理由：

1. **Go 不会让 DIL 编译器变成 Go 编译器。** `dil.js`（662 行，含流式半截输入恢复）与
   `compile.js`（425 行）仍需要一个 JS 运行时；改 Go 要么保留 JS sidecar（多一跳），要么重写解析器。
2. **真正被搬走的只有 `server.mjs`（131 行）与 `js/server.js`（271 行）**——即负责组织既有能力的那两层。
3. **`catalog.js` 是唯一真相源**（§1.3），跨语言会使它退化为两份手抄的目录，
   而 `test/smoke.mjs` 的三条不变量护不住跨语言漂移。
4. Go 的强项（高并发、低延迟、单二进制部署）在这个单机、单用户、CPU 极轻的 lab 里用不上；
   瓶颈是"编译语义是否正确"，不是吞吐。

**Go 保留为未来独立服务的技术选项**：若日后需要大量并发连接、独立部署的 API 服务、
或交付独立可执行文件时再评估。届时门禁是先建一致性套件（同一批 DIL 输入 + 期望的程序/JSON/patch 输出），
并把 `catalog` 降级为生成物（`catalog.js` → JSON → Go codegen）以保住单源。

### 11.1 关于 Bun 与 TypeScript

| 事项 | 结论 |
|---|---|
| 运行时 | **Bun 1.4.3**（兼容性见 §1.5，3/3 通过） |
| TypeScript | 采用；但注意 Node 26 也能无构建跑 `.ts`，**TS 非 Bun 独有** |
| TS 的边界 | 只能约束协议信封；沙箱内编译产物无类型（见 §9 第 8 条） |
| 包管理器 | Bun（`bun install` + `workspace:*`） |
| 边界强制 | Bun 在新 monorepo 默认 `linker=isolated`，可拒绝幽灵依赖；若失效则 `bunfig.toml` 显式设 `[install] linker = "isolated"` |
| 若上 React | **必须引入构建步骤**（Vite 或 `bun build`），与 README"零依赖、无构建步骤"的身份冲突，需明确认下 |

---

## 12. Function-style UI DSL v1（阶段 1 已实现）

> 这是**新增**的一条线，与现有 DIL 链路并存。本阶段只做「解析 + 校验 + 规范化 AST」，
> 不渲染、不接模型、**不改动 DIL 的任何行为**。
> 实现在 `packages/ui-dsl`，测试 `packages/ui-dsl/tests`（64 条，全通过）。

### 12.1 为什么另起一条线

DIL 是**流式、标签式、可半截**的推理格式，为「模型逐 token 写界面」优化，
代价是解析器要处理三类恢复诊断。而用户要的是另一种输入风格：

```text
root = Stack([title, form], "column", "l")
title = TextContent("Contact Us", "large-heavy")
form = Form("contact", [nameField, emailField], formButtons)
nameField = FormControl("Name", Input("name", "Your full name", "text", null, ["required", "minLength:2"]))
formButtons = Buttons([submitBtn, cancelBtn], "row")
submitBtn = Button("Submit", "submit:contact", "primary")
```

这是**函数式 UI DSL**：平铺的变量绑定，靠**变量名**表达父子关系，不靠嵌套标签。
它的性质与 DIL 正好互补：

| | DIL（现有） | UI DSL（本阶段） |
|---|---|---|
| 半截输入 | 靠三类恢复诊断硬扛 | **天然免疫**——每行原子，写完才算数 |
| 跨重编译状态 | 需显式 `{ key: "seats" }` | **白拿**——变量名即稳定 key |
| 语法特例 | `{@body}` / `{#if}` / `{#each}` 三种 | **没有特例**——`{@body}` 退化成普通赋值、`{#each}` 退化成 `.map()` |
| 散文与界面同源 | Markdown 与组件编进同一棵树 | **待设计**（见 12.6 限制） |

### 12.2 语法（v1）

```text
program    := definition*
definition := IDENT "=" value
value      := call | array | STRING | NUMBER | "true" | "false" | "null" | IDENT
call       := IDENT "(" (value ("," value)* ","?)? ")"
array      := "[" (value ("," value)* ","?)? "]"
```

要点：

- **位置参数**。顺序由 `registry.ts` 冻结声明，与 `catalog` 的真实签名逐条一致。
  夹在中间的可选参数**不必写 `null` 占位** —— 实参按类型对到参数槽上（规则见 12.5）：

  ```text
  Input("name", "Your full name", "text", ["required", "minLength:2"])
        └ name   └ placeholder      └ type  └ rules（value 被按类型跳过）
  ```
- **空白自由**。语句间无分隔符 token（值自身可终结），所以换行、缩进、一行多条都可解析。
- **字符串**支持 JS 风格转义：`\n \t \r \b \f \v \0 \uXXXX \" \' \\`，未识别转义保留原字符。
- 数字支持整数/小数/指数与负号。
- 不接受：任意表达式、函数/循环/条件、`import`、运算符、模板串、对象字面量、注释。

### 12.3 解析流水线（顺序无关的真正原因）

```text
阶段一  collectDefinitions   收全部顶层定义；重复定义立即报错；不要求引用目标已存在
阶段二  resolveReferences    解析引用；未定义报错；循环报错并给路径；算可达性
        bindArguments        实参 → 参数槽（按类型对齐；可选参数可跳过）
        validateTree         组件存在性 / 参数类型 / root 校验
        normalize            只把 root 可达的组件节点放进最终 AST
```

单趟解析会在 `root` 引用后定义的 `title` 时失败 —— 所以必须先收全量符号再连边。
另一个刻意选择：**解析全部定义**（含死代码），死代码里的未定义引用与循环同样是错误；
但**进入最终 AST 的只有 root 可达的节点**，两件事分开管。

### 12.4 不执行，只解析

硬约束：全流程只有字符扫描 + 建树 + 查表。
**没有 `eval` / `new Function` / `vm` / `child_process`，也没有用正则生成代码。**

这条不变量由测试钉住 —— `dsl.test.ts` 会逐文件扫描 `src/`，剥掉注释后断言不含上述原语。
同时验证：`root = eval("1+1")` 与 `root = Function("return 1")` 都只是
「未注册组件」（`E_UNKNOWN_COMPONENT`），**没有特殊通路**；
`'}); require("child_process").execSync(...)` 这类载荷原样保留为字符串数据，不产生副作用。

### 12.5 错误模型

结构化诊断，不是模糊字符串。位置（偏移 + 行 + 列）永远带上。

| 类别 | 错误码 |
|---|---|
| 边界 | `E_SOURCE_TOO_LONG` `E_EMPTY_SOURCE` `E_DEPTH_EXCEEDED` `E_NODE_BUDGET_EXCEEDED` |
| 词法/语法 | `E_UNEXPECTED_CHAR` `E_UNEXPECTED_TOKEN` `E_UNTERMINATED_STRING` `E_EXPECTED_TOKEN` |
| 阶段一 | `E_DUPLICATE_DEFINITION` |
| 阶段二 | `E_UNDEFINED_REFERENCE` `E_CYCLIC_REFERENCE` `E_MISSING_ROOT` |
| 校验 | `E_UNKNOWN_COMPONENT` `E_ARG_COUNT` `E_MISSING_REQUIRED_ARG` `E_ARG_TYPE` `E_ROOT_NOT_COMPONENT` |
| 警告 | `W_UNUSED_DEFINITION` `W_SKIPPED_OPTIONAL` |

成功/失败是**可判别联合**，TypeScript 靠 `ok` 直接窄化：

```ts
const r = parseUiDsl(src);
if (r.ok) r.ast.root.component;      // ✓ ParseSuccess
else r.errors.map((d) => d.code);    // ✓ ParseFailure
```

模型里的三条语义决定：

1. **实参按类型对到参数槽，可选参数可以跳过。**
   规则在 `bind.ts`，四步：

   ```text
   ① 优先绑在当前游标处 —— 类型匹配就用它，不做任何猜测
   ② 当前槽接不住时，向后找第一个能接住的槽；只能跳过**可选**参数
   ③ 跳过的槽记作 null（显式缺省），保住「实参下标 ↔ 参数下标」的对齐
   ④ 找不到任何能接住的槽 → 报错，且报在**游标处那个参数**上
   ```

   两条**守卫**，防止「静默绑错」：

   - **必填参数不能被跳过。** `CardHeader(123)` 里 `123` 绑不到 `title`(string)，
     又越不过必填的 `title`，于是报错，而不是溜到 `subtitle` 去。
   - **枚举参数遇到字符串不匹配时不跳过。** `"textt"` 这种给错枚举值是最常见的
     拼写错误；若允许跳过，它会被静默绑到后面的 `value`(string) 上，错得毫无痕迹。
     所以宁可报错。

   这是 `Input(name, placeholder, type, value, rules)` 这类**中间夹着可选参数**的
   签名能自然使用的前提 —— 也正是 `catalog` 头部那句「位置参数 → 具名 props 的映射
   由编译器完成」的字面意思。

2. **`null` = 显式缺省。** 与「跳过」等价，两种写法并存：
   可选参数传 `null` 合法（走 catalog 默认值），必填参数传 `null` 报错。
   规范化时两者都占位成 `null`，所以下游按下标取值的逻辑不受影响。

3. **`nodes` 只接受数组，`node` 只接受单个节点。** `Stack(child)` 报错，要写 `Stack([child])`。

### 12.6 已知限制（v1 刻意不做）

| 限制 | 说明 |
|---|---|
| **散文无处安放** | DIL 里 Markdown 与组件同源；DSL 里文字只能进 `TextContent("…")`。散文同源方案未设计 |
| **按类型跳过有固有歧义** | 多个可选参数类型相近时，实参可能被跳到靠后的槽上。最典型的是 `Input(name, placeholder, type, value, rules)`：`placeholder` / `value` 都是 string，若作者本意是把字符串给 `value` 却写在 `placeholder` 位置，无法靠类型分辨。枚举拼写错误已由守卫挡住，但 string 之间的误绑无法自动识别。需要审计时打开 `reportSkippedArguments: true`，会为每次跳过产出 `W_SKIPPED_OPTIONAL` 并指明绑到了哪个参数 |
| `array` 不做元素级收紧 | catalog 把 `rules` / `options` 都声明为 `array`，未区分元素类型。所以 `'array'` 接受「字面量或节点」的任意组合。收紧需要改 catalog（会改语义），v1 不动 |
| 无 map/条件 | `{#each}`、`{#if}` 对应的能力未设计（不引入任意表达式是有意的） |
| 无 AppBlock 逃生舱 | DIL 的 `AppBlock`（自包含小应用塞 iframe）在 DSL 里没有对应形式 |
| 注册表只 15 个组件 | Stack / Card / CardHeader / Separator / TextContent / InlineHeader / Form / FormControl / Input / TextArea / Select / SelectItem / Slider / Buttons / Button |
| 不做默认值填充 | 注册表记录 catalog 的 `default` 仅用于一致性校验与文档；DSL 层不填默认值，交由下游 |
| 未接消费方 | 本阶段不接 React、不接模型、不替换 DIL |

### 12.7 签名为什么手写冻结，而不是从 catalog 派生（已被 §14.3 取代）

位置参数是**契约**：第 3 个参数是 `gap` 就永远是 `gap`。
若注册表跟着 catalog 自动走，catalog 里一旦调整参数顺序或往前插一个新参数，
DSL 里所有已有写法会**静默改变含义** —— 源文本毫无变化，语义却变了。

所以签名手写、冻结，配一个**一致性测试**（`registry-conformance.test.ts`）逐字段比对
真实 catalog 的 `name / type / required / default / enum` 与 token 表：

- 两边一致 → 通过，契约可信
- 两边不一致 → **测试失败**，逼人做一次有意识的决定（改 DSL / 保留旧签名 / 发大版本）

同时反向断言 `REGISTRY.size < CATALOG.size` —— 证明注册表确实是一层**白名单约束**，
而不是 catalog 的副本。

### 12.8 组件参数契约的来源

全部来自 `packages/catalog/src/index.js` 的真实声明，`@openui-lab/catalog` 是真的被
一致性测试 import 的（不是抄一遍）。参数顺序对齐 OpenUI 内置库
（`@openuidev/react-ui`），这一点 catalog 头部注释里本来就写着：

> 组件名与参数顺序对齐 OpenUI 内置库（@openuidev/react-ui），位置参数 → 具名 props 的映射由编译器完成。

即：**catalog 早就是照位置参数设计的，只是 DIL 那条链路没有实现它。** DSL v1 把这一层补上了。

### 12.9 验收结果（阶段 1）

| 检查 | 结果 |
|---|---|
| `bun run test:dsl` | ✅ **78 条全通过，515 条断言** |
| `bun run typecheck:dsl` | ✅ `tsc --noEmit` 无错误 |
| Contact Us 示例 | ✅ 解析 + 校验通过，**零诊断**（原文一个 `null` 都不写） |
| 原有测试回归 | ✅ `bun run test` 94 条全通过，**输出与基线逐字节一致** |
| 原有 `compiler` / `protocol` / `runtime` / 静态 URL | ✅ 未改动 |
| 动态执行原语 | ✅ 无（测试逐文件扫描 `src/`） |
| 覆盖清单 | ✅ 15 项全覆盖（见 `tests/dsl.test.ts` 的分组编号） |

### 12.10 后续阶段（未开始）

| 阶段 | 内容 |
|---|---|
| 2 | 散文同源方案；`{#each}` 对应的 map 能力；AppBlock 逃生舱的 DSL 形式 |
| 3 | React 渲染器：把规范化 AST 映射到预注册的 React 组件（**需先定 React 范围，见 §9 第 1 条**） |
| 4 | 接入模型：由注册表生成提示词，让不同模型产出同一份 DSL |
| 5 | 与 DIL 的关系定型：并存、替换、还是 DSL 作为 DIL 的一种前端 |

**本阶段到此停止，等待验收，不自动进入阶段 2。**

---

## 14. OpenUI Lang 取代 DIL

### 14.1 决定

模型输出从声明式 DIL（Markdown + JSX 标签 + `{@body}` / `{#if}` / `{#each}` + JS 表达式）
改为函数式 [OpenUI Lang](https://www.openui.com/docs/openui-lang)。模型只负责**结构组合**：

| 保留 | 去掉 |
|---|---|
| 任意深度的组件嵌套、变量引用、数组参数、数据型组件（`Series` / `Slice` / `Col` / `SelectItem`） | 状态（`useState`）、表达式与插值、控制块、`AppBlock` 逃生舱、Markdown 散文、`appData` 数据绑定 |

交互改由按钮约定承担：`submit:<表单id>` / `turn:<文字>` / `action:<名字>`。需要「算」的东西由模型在下一轮算好再组合出来。

沙箱 worker、操作协议、渲染器框架**不变**：编译器产出的程序形状与以前一致（`__dil.jsx` + 常量表 + 稳定 key），只是前端从 DIL 换成 OpenUI Lang。

### 14.2 流水线

```text
原文 ──▶ ui-dsl analyzeUiDsl（宽容）──▶ compiler compile ──▶ JS 程序 + 常量表 ──▶ worker ──▶ 操作 ──▶ 渲染器
```

`analyzeUiDsl` 的约定是「永远产出一棵能渲染的树」：

| 情况 | 流式中（`final: false`） | 流结束（`final: true`） |
|---|---|---|
| 末尾语句没写完 | 补齐字符串与括号后渲染，记恢复诊断；补不齐就丢掉 | `E_INCOMPLETE_STATEMENT`，丢掉 |
| 引用了还没写到的变量 | 先空着（`pending`），位置用 null 占住 | `E_UNDEFINED_REFERENCE` |
| 未知组件 / 缺必填 | 只摘这个组件，兄弟照常 | 同左 |
| 参数绑不上（如枚举值非法） | 只丢这个参数，用默认值 | 同左 |
| 同名变量再定义 | 后者覆盖前者（`W_REDEFINED`） | 同左 |
| 补齐语句里冒出的问题 | 记为恢复诊断，不算错误 | — |

严格入口 `parseUiDsl` 保留，供需要「全对才接受」的场景。

### 14.3 组件一文件一个，注册表从目录派生

`packages/catalog/src/components/<Name>.js` 用 `defineComponent` 同时声明签名、渲染实现、样式（`css`）、退化文字（`markdown`）；`components/index.js` 一行登记。几个组件共用的家族样式在 `catalog/src/styles.js`，`apps/web/css/app.css` 只剩外壳与主题变量。由它派生：

- `ui-dsl/src/registry.ts`：DSL 的组件注册表（不再手写冻结）
- `apps/web/src/renderer.js`：组件渲染表 + 组件自带样式注入
- `generatePrompt()`：system prompt 里的签名列表

这推翻了 §12.7「签名手写冻结」。理由：冻结的目的是防止参数顺序悄悄改变已有写法的含义，但模型的提示词由目录实时生成，模型写的永远是当前签名；已经存下的旧回答若要重放，靠 `tests/smoke.mjs` 里五个演示的端到端用例兜住——参数顺序一改，演示就编不过。

`render.update` 必须配 `render.updates`（它原位处理的属性列表），`defineComponent` 加载时校验。流式中组件可能先以半截参数创建，之后其他属性被补全；渲染器发现 SET 里有未声明的属性就整块重建，避免界面停在半截状态。

### 14.4 会话总结：同一条流里的 summary 行

聊天页左边是界面，右边是会话总结。模型仍然只写一条 OpenUI Lang 流，最后一行写：

```
summary = [Note("标题", "一两句话", ["引用的变量"]), ...]
```

- `analyzeUiDsl(src, { sidecars: ['summary'] })`：sidecar 变量单独取值（`result.sidecars`），不参与 root 选择、不报未引用
- `compile()` 把它编成 `out.summary = [{ title, text, refs }]`，不进程序；`refs` 写字符串或直接写变量名都行
- 具名节点多带一个 `__var` 属性，渲染器写成 `data-var`；右栏点引用 → 左边 `[data-var=…]` 定位并闪一下
- 流式中 summary 随重编译逐条长出来；模型没写 summary 时右栏按界面结构补一条

### 14.5 验收

| 检查 | 结果 |
|---|---|
| `bun run test:dsl` | ✅ 94 条（含 12 条宽容分析、3 条 sidecar） |
| `bun run typecheck:dsl` | ✅ |
| `bun run test` | ✅ 每个演示每隔 9 字符切一刀都能编译、沙箱无错误、根节点跨重编译不重建；六段 summary 的引用全部落在界面变量上 |
| 浏览器 `index.html` | ✅ 例子离线回放：总结逐条出现、画布徽标「运行正常」、点引用定位到组件；`turn:` 按钮无模型时回放预置下一轮 |
| 浏览器 `demos.html` | ✅ 五个演示零诊断、零运行时错误、零未知组件 |

---

## 13. 文档依据

| 结论 | 依据 |
|---|---|
| 依赖图、`appData` 形状、`SERVER_RESOLVED`、patch 形状、关键行号 | 读源码实测 |
| `worker-runtime.js` 与 `runner.html` 的资产性质 | 读 `js/session.js:144`、`runner.html:48`、`test/smoke.mjs:17` |
| `node:sqlite` 可用 | 本机 Node 26.10 实测建表读写 |
| DBX 三态与已有连接 | 调用 DBX MCP 只读工具实测 |
| 本机无数据库服务、项目非 git 仓库 | 进程扫描 / 文件扫描 |
| monorepo 与边界强制 | Bun 官方 isolated linker 语义（新 monorepo 默认） |
| Bun 兼容性 3/3 通过、Bun 1.4.3 已装 | 本机实测：`bun test/smoke.mjs`、静态服务、`/proxy` SSE 透传 |
| Node 26 原生 TS、`node:sqlite` 可用 | 本机实测 `.ts` 直接执行与建表读写 |
| catalog 声明位置参数但解析器未实现 | 读 `catalog.js` 头部注释、`dil.js` `scanTagHead`（108–182 行）、`compile.js` grep |
| 位置参数逐条比对结果 | 对照 `catalog.js` 各组件 `params` 声明 |
| 模型返回实物（DIL → 程序 → 27 操作 → 276 字节） | 临时脚本编译 `demo.js` 的 `team-plan` 并跑 `worker-runtime.js`（脚本已删） |
| DSL v1 组件参数契约 | 逐条对照 `packages/catalog/src/index.js` 的 `params` 声明，并由 `tests/registry-conformance.test.ts` 强制校验 |
| DSL 不执行输入 | 逐文件扫描 `packages/ui-dsl/src/`，断言无 `eval` / `new Function` / `node:vm` / `child_process` |
