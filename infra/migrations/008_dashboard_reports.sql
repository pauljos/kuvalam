CREATE TABLE IF NOT EXISTS dashboard_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  html_content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dashboard_reports_tenant_id ON dashboard_reports(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_reports_created_at ON dashboard_reports(created_at DESC);
