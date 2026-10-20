-- 多账号租户隔离：account 角色/停用；业务表 account_id

ALTER TABLE account ADD COLUMN role TEXT DEFAULT 'user';
ALTER TABLE account ADD COLUMN disabled_at INTEGER;

ALTER TABLE model_config ADD COLUMN account_id TEXT;
ALTER TABLE memory_item ADD COLUMN account_id TEXT;
ALTER TABLE kb_item ADD COLUMN account_id TEXT;
ALTER TABLE dataset ADD COLUMN account_id TEXT;
ALTER TABLE profile_tag ADD COLUMN account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_model_config_account ON model_config (account_id, sort, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_item_account ON memory_item (account_id, status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_kb_item_account ON kb_item (account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dataset_account ON dataset (account_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_conversation_user ON conversation (user_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_tag_account ON profile_tag (account_id, tag);
