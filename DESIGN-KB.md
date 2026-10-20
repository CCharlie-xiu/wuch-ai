# 知识库（AOCI）设计

> 状态：**已实施**（P1 / P2 / P3 全部落地，见 §13；前置的文件抽取见 §14）· 不动 OpenUI Lang / 编译 / 沙箱链路
> 一句话：**知识库存蒸馏后的 AOCI 条目，不存文件。文件只在对话里进来，进来时做一次蒸馏。**

## 1. 核心约定

| 约定 | 内容 |
|---|---|
| 入库时机 | 只在对话中上传文件后，由模型阅读触发 |
| 条目单位 | AOCI 单元（索引行 + 蒸馏正文 + 证据指针），非原始文件 |
| 去重 | 入库前先检索；命中直接读已有条目，不重复建 |
| 检索方式 | 索引优先：每轮注入索引行，命中才读正文 |
| 设置页 | 只读展示，**无上传入口** |
| 不存原文 | 正文只存蒸馏产物；原文以证据指针留存 |

## 2. 数据流

```text
① 对话中上传文件（附件，attachments.js 不变）
        │
② 模型阅读 → kb_lookup { title, fileHash, summary }
        │
   ┌────┴────┐
 命中         未命中
   │            │
 读已有条目     模型蒸馏成 AOCI → kb_put { name, tag, summary, body }
   │            │
   └─────┬──────┘
         ▼
③ 入库 / 命中 → 之后每轮注入索引行 → 需要时 kb_get(id) 读正文
```

## 3. AOCI 条目结构

三层，对应 aoci-wuch 的 `capabilities/<name>/`：

| 层 | 内容 | 落库 |
|---|---|---|
| index | `name[tag]: 一句话核心职责` + 类型/领域/成熟度 | `kb_item` 列 |
| body | 蒸馏正文（固定骨架） | `blob`（按 sha256 去重） |
| evidence | 会话 / 轮次 / 文件名 / 文件 hash | `kb_evidence` |

蒸馏骨架（第一次阅读时由模型产出一次）：

```md
# <name>
tag: [类型+领域+价值+成熟度]
一句话：<核心职责>

## 何时用
## 要点
## 步骤 / 方法
## 边界（不做什么）
```

## 4. Schema（migration `007_knowledge.sql`）

```sql
CREATE TABLE IF NOT EXISTS kb_item (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  tag          TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL,            -- 一句话核心职责
  kind         TEXT NOT NULL DEFAULT 'doc',
  domain       TEXT NOT NULL DEFAULT '',
  maturity     TEXT NOT NULL DEFAULT 'draft',
  dedup_key    TEXT NOT NULL,            -- 内容指纹，见 §5
  body_hash    TEXT NOT NULL,            -- → blob(hash)
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','archived')),
  source_kind  TEXT NOT NULL DEFAULT 'conversation',
  confidence   REAL NOT NULL DEFAULT 0.6,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  last_hit_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_item_dedup ON kb_item (dedup_key);
CREATE INDEX IF NOT EXISTS idx_kb_item_list  ON kb_item (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_evidence (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id           TEXT NOT NULL REFERENCES kb_item(id) ON DELETE CASCADE,
  conversation_id TEXT,
  turn_id         TEXT,
  file_name       TEXT,
  file_hash       TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_evidence_kb ON kb_evidence (kb_id);
```

`body` 复用现有 `blob` 表（与 dataset 同源去重），不新建。

**没有用 FTS5。** 实测 `tokenize='trigram'` 下中文两字词（「暗色」）搜不到，得不偿失；
检索改成扫索引列（`name / summary / tag` 上的 `LIKE … ESCAPE '\'`），正文不参与检索 ——
这反而更贴合「索引优先、命中才读正文」。条目上万再换 FTS。

## 5. 去重键（dedup_key）

按优先级取第一个非空：

| 级别 | 键 | 命中含义 |
|---|---|---|
| 1 | `file:<sha256>` | 同一文件重复上传 |
| 2 | `title:<指纹(name)>` | 同名主题 |
| 3 | `sum:<指纹(summary)>` | 同义摘要 |

指纹函数复用 `memory.mjs` 的 `fingerprint()`（去空白 / 小写 / 去人称前缀）。
模糊命中（2、3 级）默认**不自动合并**，返回候选让模型决定。

## 6. 接口（`api.mjs` 路由表新增）

| 方法 | 路径 | 说明 | 调用方 |
|---|---|---|---|
| POST | `/kb/lookup` | 去重检索：`{ title, fileHash, summary }` → `{ hit, reason }` | 模型 |
| POST | `/kb/items` | 建条目：`{ name, tag, summary, body, evidence }` | 模型 |
| GET | `/kb/items` | 列表 | 设置页 |
| GET | `/kb/items/:id` | 详情：index + body + evidence | 设置页 / 模型 |
| POST | `/kb/search` | 索引检索：`{ query, limit }` → 命中行 | 模型 |
| GET | `/kb/index` | 索引清单（注入 prompt 用） | 模型 |
| PATCH | `/kb/items/:id` | 改标签 / 一句话 / 归档 | 设置页 |
| DELETE | `/kb/items/:id` | 软删 | 设置页 |

`/kb/lookup` 命中时 `hit_count++`，返回条目摘要。

## 7. 模型工具（`model.js` 新增 `KB_TOOLS`）

| 工具 | 参数 | 作用 |
|---|---|---|
| `kb_lookup` | `{ title, fileHash?, summary? }` | 先查。命中返回 id + 摘要；未命中 `{ hit: null }` |
| `kb_put` | `{ name, tag, summary, body, evidence }` | 建条目。内部再跑一次 lookup 兜底 |
| `kb_get` | `{ id }` | 读正文 |

prompt 规则：

```text
- 用户上传文件、或说「记住这个」时：先 kb_lookup；命中就直接引用，不要 kb_put。
- 未命中才 kb_put，body 按固定骨架蒸馏，不要贴原文。
```

## 8. 设置页「知识库」分类

`index.html`：

```html
<button type="button" role="tab" data-stab="kb">知识库</button>
...
<section class="settings-pane" data-spane="kb" role="tabpanel" hidden>
  <h2>知识库</h2>
  <p class="settings-desc">只在对话中产生：上传文件 → AI 阅读后蒸馏入库。这里只读。</p>
  <div id="kb-list" class="kb-list"></div>
</section>
```

`settings-page.js` 新增 `renderKb()`：

| 展示 | 操作 |
|---|---|
| name / tag / 一句话 / 命中次数 / 来源会话 | 展开看 body + 证据；归档、删除 |
| — | 无上传、无编辑正文 |

## 9. 检索侧

| 环节 | 做法 | 参照 |
|---|---|---|
| 每轮注入 | system prompt 附「知识库索引」一行一条，限 N 条 | `memory.promptBlock()` |
| 按需读正文 | 模型调 `kb_get(id)` | — |
| 命中计数 | `kb_get` 时 `hit_count++` | — |

## 10. 与现有模块

| 模块 | 关系 |
|---|---|
| `memory.mjs` | 记忆=原子事实（不存原文）；知识库=蒸馏文档（存正文）。指纹/去重复用 |
| `dataset` | 数据集=表格 + 版本链；知识库=文档蒸馏。共用 `blob` 表 |
| `attachments.js` | 上传入口不变；新增「存入知识库」触发点 |
| `tools.mjs` | kb_* 同类模型工具，但**写操作**（tools 全只读） |
| `settings-page.js` | 新增 kb pane，只读 |

## 11. 分阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | migration + `kb.mjs` repo + 只读接口 + 设置页 pane | ✅ 已完成 |
| P2 | 模型工具 kb_lookup / kb_put / kb_get + 索引注入 | ✅ 已完成 |
| P3 | 附件「存入知识库」显式触发 | ✅ 已完成 |

## 12. 已定的四条

| # | 问题 | 结论 |
|---|---|---|
| 1 | 蒸馏由模型做还是服务端规则做 | 模型（规则抽不动文档） |
| 2 | 模糊命中（标题/摘要）是否自动合并 | 不自动合并；`create` 内部只做兜底查重，命中即返回已有条目 |
| 3 | 知识库是否跨会话全局共享 | 全局（单用户） |
| 4 | 是否保留原文副本 | 不保留，只留证据指针 |

## 13. 实施清单

| 文件 | 改了什么 |
|---|---|
| `apps/server/data/migrations/007_knowledge.sql` | 新增：`kb_item` + `kb_evidence`（版本 7） |
| `apps/server/src/kb.mjs` | 新增：`createKnowledgeRepo` + `dedupKeys`；lookup / create / list / get / search / index / promptBlock / patch / archive |
| `apps/server/src/api.mjs` | 新增 8 条 `/kb/*` 路由（自动进设置页「数据库接口列表」） |
| `apps/server/src/tools.mjs` | `TOOL_META` 加 kb_lookup（auto）/ kb_put（ask）/ kb_get（auto），出现在「工具」页可开关 |
| `apps/web/src/model.js` | 新增 `KB_TOOLS` / `KB_TOOL_NAMES`；`buildChatPrompt` 加 `kb` / `kbIndex`，写死「先 lookup 再 put，命中直接引用」 |
| `apps/web/src/kb-client.js` | 新增：`loadKbIndex` / `invalidateKbCache` / `listKb` / `getKb` / `patchKb` / `archiveKb` |
| `apps/web/src/session.js` | 工具路由（`TOOL_PATHS` / `SERVER_TOOL_NAMES`）；每轮注入知识库索引；`kb_put` 成功后作废索引缓存 |
| `apps/web/index.html` · `settings-page.js` · `app.css` | 新增 `data-stab="kb"`「知识库」只读分类（搜索 / 含已归档 / 展开看正文与证据 / 归档） |
| `apps/web/src/attachments.js` · `chat.js` | 文本与图片附件 chip 加「存」按钮：填指令并直接发送，走 lookup → put |
| `apps/server/tests/kb.test.mjs` | 新增 9 条断言；`memory.test.mjs` / `conversations.test.mjs` 的 schemaVersion 断言 6 → 7 |

## 14. 前置：文件内容得先到模型手上（已补）

设计稿假定「模型阅读文件」，但当时**附件里只有文本文件的内容会进消息**，
pdf / docx / pptx 只带文件名（`attachments.js` 原来那句「只拿到文件名，内容没有解析」）。
入库流程对文档型知识因此是空的，先把这个洞补上：

| 文件 | 改了什么 |
|---|---|
| `apps/server/src/files.mjs` | 新增：`extractText`。pdf 走 `pdfjs-dist`（只取文字层）；docx / pptx / odt / ods / odp 用 `node:zlib` 手写 zip 读取 + XML 抽文本，**不引额外依赖**；文本类直接 utf8。返回 `{ text, chars, truncated, sha256, via }` |
| `apps/server/src/api.mjs` | 新增 `POST /files/extract`（请求体即文件，`?name=` 带文件名） |
| `apps/web/src/attachments.js` | 附件加 `doc` 类：走 `/files/extract` 抽正文，之后与文本同路；每个附件用 `crypto.subtle` 算 `sha256` |
| `apps/web/src/chat.js` | 接线 `extractDoc`；「存」指令里带上 sha256，供 `kb_lookup` 一级去重 |
| `apps/server/tests/files.test.mjs` | 新增 8 条断言（含手搓 zip / pdf 夹具） |

**为什么 sha256 要在浏览器端算**：模型拿不到文件字节，只能照抄我们给它的字符串。
把 sha256 写进消息头（`【文件 x.pdf｜sha256 …】`），模型传给 `kb_lookup` / `kb_put` 的就是同一个值，
`file:<sha256>` 这一级去重才真的生效。

**已知边界**：进消息正文仍是 2 万字上限（`INLINE_TEXT_MAX`），超长文档会被截断；
扫描件 pdf 没有文字层，抽出来是空的 —— 前端会直接报「没抽出正文」。
正文要按需分次读，得再加一个模型侧 `read_file` 工具，本期没做。
