-- 记忆 + 知识库 blob + 技能（对齐本地 003 / 006 / 007 / 008 缓存列；不含 dataset 表）

CREATE TABLE IF NOT EXISTS blob (
  hash       TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_metrics (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id     TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  turn_id             TEXT,
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,
  completion_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  context_usage       REAL,
  cache_hit_tokens    INTEGER,
  cache_miss_tokens   INTEGER,
  estimated           INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS kb_item (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL DEFAULT '',
  tag          TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'doc'
               CHECK (kind IN ('doc', 'capability', 'note', 'snippet')),
  domain       TEXT NOT NULL DEFAULT '',
  maturity     TEXT NOT NULL DEFAULT 'draft'
               CHECK (maturity IN ('draft', 'stable', 'retired')),
  dedup_key    TEXT NOT NULL,
  body_hash    TEXT NOT NULL REFERENCES blob(hash),
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'archived')),
  source_kind  TEXT NOT NULL DEFAULT 'conversation',
  confidence   REAL NOT NULL DEFAULT 0.6,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  last_hit_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_item_dedup ON kb_item (dedup_key);
CREATE INDEX IF NOT EXISTS idx_kb_item_list ON kb_item (status, updated_at DESC);

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

CREATE TABLE IF NOT EXISTS skill (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL DEFAULT '1',
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT,
  prompt      TEXT,
  manifest    TEXT,
  builtin     INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO skill (id, name, description, builtin, created_at, updated_at)
  VALUES ('canvas', 'Canvas', '用图形、连线和文字画示意图', 1, 0, 0);
INSERT OR IGNORE INTO skill (id, name, description, builtin, created_at, updated_at)
  VALUES ('sheet', 'Excel', '可编辑表格，支持公式与 xlsx 导入导出', 1, 0, 0);

CREATE TABLE IF NOT EXISTS conversation_skill (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  skill_id        TEXT NOT NULL REFERENCES skill(id),
  enabled         INTEGER NOT NULL DEFAULT 1,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, skill_id)
);
