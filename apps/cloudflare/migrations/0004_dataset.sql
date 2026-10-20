-- 数据集（导入表格 / 用户编辑）；内容按哈希存 blob，版本链。不含 blob 表（0003 已建）。

CREATE TABLE IF NOT EXISTS dataset (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversation(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  source_blob     TEXT REFERENCES blob(hash),
  source_name     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dataset_conversation ON dataset (conversation_id, deleted_at);

CREATE TABLE IF NOT EXISTS dataset_version (
  id         TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES dataset_version(id),
  data_blob  TEXT NOT NULL REFERENCES blob(hash),
  author     TEXT NOT NULL CHECK (author IN ('import', 'user', 'ai', 'skill')),
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dataset_version ON dataset_version (dataset_id, created_at);
