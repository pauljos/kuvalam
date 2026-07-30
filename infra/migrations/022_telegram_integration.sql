-- 022_telegram_integration.sql
-- Telegram Bot API integration — live conversational agents over Telegram
-- Enables agents to send/receive Telegram messages via Bot API.
-- Reference: https://core.telegram.org/bots/api

-- ── Telegram sessions: persistent conversation state per agent+chat ──────
CREATE TABLE IF NOT EXISTS telegram_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,               -- Telegram chat ID (integer)
  username VARCHAR(255),                  -- @username or first_name
  display_name VARCHAR(255),
  chat_type VARCHAR(20) DEFAULT 'private', -- private, group, supergroup, channel
  session_state JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN DEFAULT true,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_tenant_agent ON telegram_sessions(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_tg_chat ON telegram_sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_tg_active ON telegram_sessions(is_active) WHERE is_active = true;

-- ── Telegram message log: full history per session ────────────────────────
CREATE TABLE IF NOT EXISTS telegram_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES telegram_sessions(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  telegram_message_id BIGINT,            -- Telegram's message ID for dedup
  content TEXT NOT NULL,
  content_type VARCHAR(30) DEFAULT 'text', -- text, photo, document, callback_query
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tgm_session ON telegram_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tgm_tg_id ON telegram_messages(telegram_message_id);

-- ── Trigger: update telegram_sessions.updated_at on message insert ────────
CREATE OR REPLACE FUNCTION update_tg_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE telegram_sessions
  SET updated_at = NOW(), last_message_at = NOW()
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tg_message_insert ON telegram_messages;
CREATE TRIGGER trg_tg_message_insert
  AFTER INSERT ON telegram_messages
  FOR EACH ROW EXECUTE FUNCTION update_tg_session_timestamp();

-- ── RLS policies ──────────────────────────────────────────────────────────
ALTER TABLE telegram_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tg_sessions_tenant_isolation ON telegram_sessions;
CREATE POLICY tg_sessions_tenant_isolation ON telegram_sessions
  FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tg_messages_tenant_isolation ON telegram_messages;
CREATE POLICY tg_messages_tenant_isolation ON telegram_messages
  FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
