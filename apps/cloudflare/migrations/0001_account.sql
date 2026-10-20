-- OpenUI Lab · Cloudflare D1：账号与登录会话（与本地 009_account 语义对齐）

CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'email'
                CHECK (provider IN ('email', 'wechat', 'github')),
  password_hash TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email ON account (email);

CREATE TABLE IF NOT EXISTS auth_session (
  token       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auth_session_account
  ON auth_session (account_id, revoked_at, expires_at);
