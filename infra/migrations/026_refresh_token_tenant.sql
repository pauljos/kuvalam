-- Migration 026: Store tenant_id on refresh_tokens so that token refresh
-- re-issues a token scoped to the correct tenant.
-- Previously the refresh path queried `LIMIT 1` on tenant_members which
-- could select an arbitrary tenant for multi-tenant users.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_tenant
  ON refresh_tokens (user_id, tenant_id) WHERE revoked = false;

COMMENT ON COLUMN refresh_tokens.tenant_id IS
  'Tenant the user was logged into when this token was issued. Used to restore correct tenant context on refresh.';
