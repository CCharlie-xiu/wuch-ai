-- 版本 6：跨会话记忆（L2）+ Token 计量 + 会话排除 + 画像标签。
-- 硬约束：记忆层不存原文；证据只存 conversation_id / turn_id 指针。
-- 设置（启用 / 计入画像 / 门槛）放 app_setting（key = memory.config）。

CREATE TABLE IF NOT EXISTS session_metrics (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  turn_id          TEXT,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  context_usage    REAL,
  estimated        INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_metrics_conv
  ON session_metrics (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS session_exclusion (
  conversation_id TEXT PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  excluded_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_summary (
  conversation_id TEXT PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL DEFAULT '',
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_item (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL
                  CHECK (type IN ('fact', 'preference', 'goal', 'decision', 'constraint', 'temp')),
  statement       TEXT NOT NULL,
  statement_key   TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0,
  evidence_count  INTEGER NOT NULL DEFAULT 0,
  half_life       INTEGER NOT NULL DEFAULT 90,
  status          TEXT NOT NULL DEFAULT 'candidate'
                  CHECK (status IN ('candidate', 'active', 'confirmed', 'rejected', 'superseded')),
  signal          TEXT NOT NULL DEFAULT 'inferred'
                  CHECK (signal IN ('user_asserted', 'inferred')),
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  superseded_by   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_item_key ON memory_item (statement_key);
CREATE INDEX IF NOT EXISTS idx_memory_item_status ON memory_item (status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_memory_item_type ON memory_item (type, status);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id        TEXT NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL,
  turn_id          TEXT,
  signal           TEXT NOT NULL DEFAULT 'inferred'
                   CHECK (signal IN ('user_asserted', 'inferred')),
  created_at       INTEGER NOT NULL,
  UNIQUE (memory_id, conversation_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_evidence_conv
  ON memory_evidence (conversation_id);

CREATE TABLE IF NOT EXISTS profile_tag (
  id                 TEXT PRIMARY KEY,
  tag                TEXT NOT NULL,
  value              TEXT NOT NULL,
  confidence         REAL NOT NULL DEFAULT 0,
  source_memory_ids  TEXT NOT NULL DEFAULT '[]',
  updated_at         INTEGER NOT NULL,
  UNIQUE (tag, value)
);

CREATE INDEX IF NOT EXISTS idx_profile_tag_list ON profile_tag (tag, confidence DESC);
