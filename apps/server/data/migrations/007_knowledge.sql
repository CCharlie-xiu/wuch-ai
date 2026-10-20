-- 版本 7：知识库（AOCI 条目）。存蒸馏产物，不存原文；原文只留证据指针。
-- 索引行（name / tag / summary）直接放在 kb_item 上，正文进 blob（按 sha256 去重，
-- 与数据集同源）。检索走 LIKE 扫索引列 —— 中文两字词在 FTS5 trigram 下搜不到，
-- 不值得为它单开一张 FTS 表。

CREATE TABLE IF NOT EXISTS kb_item (
  id           TEXT PRIMARY KEY,                     -- kb_xxxxxxxx
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL DEFAULT '',
  tag          TEXT NOT NULL DEFAULT '',             -- [类型+领域+价值+成熟度]
  summary      TEXT NOT NULL DEFAULT '',             -- 一句话核心职责
  kind         TEXT NOT NULL DEFAULT 'doc'
               CHECK (kind IN ('doc', 'capability', 'note', 'snippet')),
  domain       TEXT NOT NULL DEFAULT '',
  maturity     TEXT NOT NULL DEFAULT 'draft'
               CHECK (maturity IN ('draft', 'stable', 'retired')),
  dedup_key    TEXT NOT NULL,                        -- 三级指纹，见 src/kb.mjs 的 dedupKeys
  body_hash    TEXT NOT NULL REFERENCES blob(hash),  -- 蒸馏正文（markdown）
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
