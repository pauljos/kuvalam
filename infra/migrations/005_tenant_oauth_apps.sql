-- Per-tenant OAuth application credentials (BYOC — Bring Your Own Credentials).
-- Each tenant registers their own OAuth app (Client ID + Client Secret) for a
-- given provider (google, slack, jira, microsoft, salesforce) so we never
-- ship or require platform-wide OAuth secrets in env vars for production.
--
-- The secret is encrypted at rest with the same AES-256-GCM key the rest of
-- the credential store uses. The application layer performs encrypt/decrypt;
-- the DB stores an opaque ciphertext string.

CREATE TABLE IF NOT EXISTS tenant_oauth_apps (
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,   -- backend provider id: google | slack | jira | microsoft | salesforce
  client_id          TEXT NOT NULL,
  client_secret_enc  TEXT NOT NULL,   -- AES-256-GCM ciphertext (see crypto.service.js)
  redirect_uri       TEXT,            -- optional override; when NULL, service uses API_URL + /api/v1/oauth/callback
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID,
  PRIMARY KEY (tenant_id, provider)
);

-- Same isolation model as tool_connections: tenants can only see their own rows.
ALTER TABLE tenant_oauth_apps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_oauth_apps_isolation ON tenant_oauth_apps;
CREATE POLICY tenant_oauth_apps_isolation ON tenant_oauth_apps
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
