-- 会话树 + 模型配置（对齐本地 schema / 002 / 005 的核心字段）

CREATE TABLE IF NOT EXISTS conversation (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  title         TEXT NOT NULL DEFAULT '',
  turn_count    INTEGER NOT NULL DEFAULT 0,
  head_turn_id  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_conversation_list
  ON conversation (deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS turn (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  parent_id       TEXT,
  active_child_id TEXT,
  depth           INTEGER NOT NULL DEFAULT 1,
  mode            TEXT NOT NULL DEFAULT 'new',
  user_text       TEXT NOT NULL,
  raw             TEXT NOT NULL DEFAULT '',
  snapshot        TEXT NOT NULL DEFAULT '',
  refs            TEXT,
  skills          TEXT,
  state           TEXT NOT NULL DEFAULT 'complete'
                  CHECK (state IN ('streaming', 'complete', 'error', 'cancelled')),
  summary         TEXT,
  failure         TEXT,
  replay          TEXT,
  model           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_turn_parent ON turn (conversation_id, parent_id);

CREATE TABLE IF NOT EXISTS head_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  from_turn_id    TEXT,
  to_turn_id      TEXT,
  op              TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_head_log ON head_log (conversation_id, id);

CREATE TABLE IF NOT EXISTS model_config (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT '',
  base_url    TEXT NOT NULL DEFAULT '',
  api_key     TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  temperature REAL NOT NULL DEFAULT 0.7,
  thinking    INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_config_list ON model_config (sort, created_at);

CREATE TABLE IF NOT EXISTS app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);
