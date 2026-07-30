-- 021_whatsapp_integration.sql
-- WhatsApp Cloud API integration — live conversational agents over WhatsApp
-- Enables agents to send/receive WhatsApp messages via Meta's Cloud API.

-- ── WhatsApp sessions: persistent conversation state per agent+phone ──────
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  display_name VARCHAR(255),
  session_state JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN DEFAULT true,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_ws_tenant_agent ON whatsapp_sessions(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_ws_phone ON whatsapp_sessions(phone_number);
CREATE INDEX IF NOT EXISTS idx_ws_active ON whatsapp_sessions(is_active) WHERE is_active = true;

-- ── WhatsApp message log: full history per session ────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  wa_message_id VARCHAR(100),       -- Meta's message ID for dedup
  content TEXT NOT NULL,
  content_type VARCHAR(30) DEFAULT 'text',  -- text, image, audio, location, interactive
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wm_session ON whatsapp_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wm_wa_id ON whatsapp_messages(wa_message_id);

-- ── WhatsApp connector config — lives in existing tool_connections ────────
-- No new table needed. Connectors of type 'whatsapp' store config:
--   { phoneNumberId, accessToken, verifyToken, businessAccountId, webhookSecret }
-- The agent_tool_scopes table grants agents access to WhatsApp connectors.

-- ── Trigger: update whatsapp_sessions.updated_at on message insert ────────
CREATE OR REPLACE FUNCTION update_ws_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE whatsapp_sessions
  SET updated_at = NOW(), last_message_at = NOW()
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ws_message_insert ON whatsapp_messages;
CREATE TRIGGER trg_ws_message_insert
  AFTER INSERT ON whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION update_ws_session_timestamp();

-- ── RLS policies ──────────────────────────────────────────────────────────
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

-- Policies for whatsapp_sessions
DROP POLICY IF EXISTS ws_sessions_tenant_isolation ON whatsapp_sessions;
CREATE POLICY ws_sessions_tenant_isolation ON whatsapp_sessions
  FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Policies for whatsapp_messages
DROP POLICY IF EXISTS ws_messages_tenant_isolation ON whatsapp_messages;
CREATE POLICY ws_messages_tenant_isolation ON whatsapp_messages
  FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
