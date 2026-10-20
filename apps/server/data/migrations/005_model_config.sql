-- 版本 5：模型配置。一行一个 OpenAI 兼容端点，可以接多个、可以改名、可以停用。
-- 早先只有一份配置放在浏览器 localStorage 里，只能替换；现在由本地库托管，
-- 「当前用哪一个」放 app_setting（key = 'activeModelId'），不占模型表的列。

CREATE TABLE IF NOT EXISTS model_config (
  id          TEXT PRIMARY KEY,                      -- m_xxxxxxxx
  name        TEXT NOT NULL,                         -- 显示名，可重命名
  provider    TEXT NOT NULL DEFAULT '',              -- 分组名，如 DeepSeek / OpenAI / 本地
  base_url    TEXT NOT NULL DEFAULT '',
  api_key     TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',              -- 上游的模型名
  temperature REAL NOT NULL DEFAULT 0.7,
  thinking    INTEGER NOT NULL DEFAULT 0,            -- 允许模型先思考（DeepSeek 用）
  enabled     INTEGER NOT NULL DEFAULT 1,            -- 关掉的不出现在输入框的切换列表里
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_config_list ON model_config (sort, created_at);

-- 应用级键值设置（单用户阶段用；模型之外的东西以后也可以放这里）
CREATE TABLE IF NOT EXISTS app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);
