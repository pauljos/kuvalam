-- 007_performance_indexes.sql
-- Add indexes to improve query performance for core tables

-- Users table indexes
CREATE INDEX IF NOT EXISTS idx_users_is_system_admin ON users(is_system_admin) WHERE is_system_admin = true;
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at DESC);

-- Tenant members - most queried for auth checks
CREATE INDEX IF NOT EXISTS idx_tenant_members_user_tenant ON tenant_members(user_id, tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant_role ON tenant_members(tenant_id, role, status);
CREATE INDEX IF NOT EXISTS idx_tenant_members_lookup ON tenant_members(user_id, status, tenant_id) 
  WHERE status = 'ACTIVE';

-- Tenants
CREATE INDEX IF NOT EXISTS idx_tenants_approval_status ON tenants(approval_status, created_at DESC);

-- Refresh tokens - cleanup queries
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, expires_at) WHERE revoked = false;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at) WHERE revoked = false;


