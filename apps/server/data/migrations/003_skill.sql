-- 版本 3：技能 = 提示词 + 工具（类似 Claude / Cursor Skill）。
-- 内置技能（canvas / sheet）的组件与提示词在 packages/catalog/src/skills/，这里登记元数据；
-- 以后接入外部技能，prompt / manifest 存在这里，tool_call 记每次工具调用。

CREATE TABLE IF NOT EXISTS skill (
  id          TEXT PRIMARY KEY,                      -- 小写 id，和 catalog 里组件的 skill 字段一致
  name        TEXT NOT NULL,
  version     TEXT NOT NULL DEFAULT '1',
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT,
  prompt      TEXT,                                  -- 外部技能的提示词；内置技能为 NULL（以 catalog 为准）
  manifest    TEXT,                                  -- JSON：{ components[], tools[], accepts[] }
  builtin     INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO skill (id, name, description, builtin, created_at, updated_at)
  VALUES ('canvas', 'Canvas', '用图形、连线和文字画示意图', 1, 0, 0);
INSERT OR IGNORE INTO skill (id, name, description, builtin, created_at, updated_at)
  VALUES ('sheet', 'Excel', '可编辑表格，支持公式与 xlsx 导入导出', 1, 0, 0);

-- 会话里选中的技能（输入框里的 chip），按会话粘滞
CREATE TABLE IF NOT EXISTS conversation_skill (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  skill_id        TEXT NOT NULL REFERENCES skill(id),
  enabled         INTEGER NOT NULL DEFAULT 1,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, skill_id)
);

-- 技能工具调用记录（预留：工具接入后每次调用一行）
CREATE TABLE IF NOT EXISTS tool_call (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT REFERENCES turn(id) ON DELETE CASCADE,
  skill_id    TEXT REFERENCES skill(id),
  tool_name   TEXT NOT NULL,
  args        TEXT,                                  -- JSON
  result_blob TEXT,                                  -- 结果较大时存 blob.hash
  state       TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'running', 'complete', 'error')),
  error       TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_call_turn ON tool_call (turn_id);
