-- Webhook sources (registered tokens)
CREATE TABLE IF NOT EXISTS webhook_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    token VARCHAR(128) NOT NULL UNIQUE,
    secret VARCHAR(512),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Webhook events (incoming payloads)
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES webhook_sources(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source VARCHAR(255) DEFAULT 'unknown',
    payload JSONB NOT NULL,
    headers JSONB,
    signature VARCHAR(512),
    processed BOOLEAN DEFAULT false,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for tenant lookups
CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant ON webhook_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_source ON webhook_events(source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_sources_token ON webhook_sources(token);

-- Enable RLS
ALTER TABLE webhook_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

-- RLS policies for webhook_sources
CREATE POLICY webhook_sources_tenant_isolation ON webhook_sources
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- RLS policies for webhook_events
CREATE POLICY webhook_events_tenant_isolation ON webhook_events
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
