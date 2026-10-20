-- 版本 4：数据集（导入的 xlsx / 用户编辑过的表格）。内容按哈希存 blob，版本连成链。
-- 数据集没有全局「当前版本」：当前用哪一版由 HEAD 那一轮的 turn.refs 决定，回退画布时数据跟着回退。

CREATE TABLE IF NOT EXISTS blob (
  hash       TEXT PRIMARY KEY,                       -- sha256(body)
  body       BLOB NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset (
  id              TEXT PRIMARY KEY,                  -- ds_xxxxxxxx，模型在原文里引用的就是它
  conversation_id TEXT REFERENCES conversation(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  source_blob     TEXT REFERENCES blob(hash),        -- 导入时的原始文件
  source_name     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dataset_conversation ON dataset (conversation_id, deleted_at);

CREATE TABLE IF NOT EXISTS dataset_version (
  id         TEXT PRIMARY KEY,                       -- dv_xxxxxxxx
  dataset_id TEXT NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES dataset_version(id),
  data_blob  TEXT NOT NULL REFERENCES blob(hash),    -- JSON：{ sheets: [{ name, cells: [[值或 "=公式"]] }] }
  author     TEXT NOT NULL CHECK (author IN ('import', 'user', 'ai', 'skill')),
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dataset_version ON dataset_version (dataset_id, created_at);
