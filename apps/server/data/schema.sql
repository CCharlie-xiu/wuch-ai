-- ─────────────────────────────────────────────────────────────────────────────
-- OpenUI Lab 本地库（SQLite）· 迁移版本 1。时间一律 Unix 毫秒，JSON 列存 TEXT。
-- 已应用的迁移不得修改（启动时校验 sha256）；改表结构在 migrations/ 下加新文件。
-- schema_version 由 src/db.mjs 维护，本文件不碰。写法规范见 .cursor/rules/backend.mdc。
-- ─────────────────────────────────────────────────────────────────────────────

-- 会话列表：一行一个会话
CREATE TABLE IF NOT EXISTS conversation (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                                  -- 预留，单用户阶段为 NULL
  title       TEXT NOT NULL DEFAULT '',
  turn_count  INTEGER NOT NULL DEFAULT 0,            -- 列表页直接读，不必 COUNT
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER                                -- 软删除
);

CREATE INDEX IF NOT EXISTS idx_conversation_list
  ON conversation (user_id, deleted_at, updated_at DESC);

-- 会话记录：一行一轮。模型上下文（history）由 state = 'complete' 的
-- user_text / raw 按 seq 取最近若干轮拼出，不单独存。
CREATE TABLE IF NOT EXISTS turn (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,                  -- 会话内从 1 递增
  user_text       TEXT NOT NULL,
  raw             TEXT NOT NULL DEFAULT '',          -- 模型写的 OpenUI Lang 原文，可回放、可重编译
  state           TEXT NOT NULL DEFAULT 'streaming'
                  CHECK (state IN ('streaming', 'complete', 'error', 'cancelled')),
  summary         TEXT,                              -- JSON: [{ title, text, refs[] }]
  failure         TEXT,
  replay          TEXT,                              -- JSON: { source, bindings }，离线例子重新生成用
  model           TEXT,                              -- 生成这一轮的模型名，便于回看
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
