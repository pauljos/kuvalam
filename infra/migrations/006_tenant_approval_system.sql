-- 006_tenant_approval_system.sql
-- Add approval workflow for tenant registration

-- Add approval_status column to tenants
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(50) NOT NULL DEFAULT 'PENDING';

-- Valid statuses: PENDING, APPROVED, SUSPENDED, REJECTED
CREATE INDEX IF NOT EXISTS idx_tenants_approval_status ON tenants(approval_status);

-- Update existing tenants to APPROVED (backwards compatibility)
UPDATE tenants SET approval_status = 'APPROVED' WHERE approval_status = 'PENDING';

-- Add approval tracking fields
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
