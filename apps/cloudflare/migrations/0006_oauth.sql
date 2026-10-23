-- OpenUI Lab · Cloudflare D1：GitHub OAuth（真实三方回调）
--
-- account 复用原表，加两列：
--   oauth_provider 'github'        —— 由真实 GitHub 授权创建的账号
--   github_login                   —— GitHub 用户名，绑定/复用唯一键
-- email 仍是普通列：GitHub 账号的主邮箱不唯一（GitHub 允许任意邮箱），
-- 登录凭据走 github_login，email 仅作展示与搜索，不参与登录判断。
--
-- auth_oauth_state：授权跳转防 CSRF。state 随机生成、落库、一次性消费，
-- 5 分钟过期；回调里对不上就拒绝。

CREATE TABLE IF NOT EXISTS auth_oauth_state (
  state       TEXT PRIMARY KEY,
  provider    TEXT NOT NULL DEFAULT 'github',
  next        TEXT NOT NULL DEFAULT '/',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_oauth_state_created ON auth_oauth_state (created_at);

-- 回调结果：GitHub 交换完成后存这里，前端轮询一次性取走（取走即删）
CREATE TABLE IF NOT EXISTS auth_oauth_result (
  state       TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,          -- JSON：{account, token, next}
  created_at  INTEGER NOT NULL
);

ALTER TABLE account ADD COLUMN oauth_provider TEXT;
ALTER TABLE account ADD COLUMN github_login TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_github_login
  ON account (oauth_provider, github_login);
