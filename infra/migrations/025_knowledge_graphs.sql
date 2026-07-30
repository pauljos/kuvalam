-- ═══════════════════════════════════════════════════════════════════════════════
-- Knowledge Graphs — named Neo4j/ArangoDB graphs for agent entity traversal
-- ═══════════════════════════════════════════════════════════════════════════════
-- Mirrors knowledge_bases for the graph side.

CREATE TABLE IF NOT EXISTS knowledge_graphs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  graph_kind      VARCHAR(50) NOT NULL DEFAULT 'neo4j',
  -- Connection details (shared infrastructure, provisioned in Settings).
  -- No defaults — in cloud deployments hosts must be explicit.
  host            VARCHAR(255) NOT NULL,
  http_port       VARCHAR(10) NOT NULL DEFAULT '7474',
  bolt_port       VARCHAR(10) NOT NULL DEFAULT '7687',
  username        VARCHAR(100) NOT NULL DEFAULT 'neo4j',
  database_name   VARCHAR(100) NOT NULL DEFAULT 'neo4j',
  status          VARCHAR(50) NOT NULL DEFAULT 'READY',
  entity_count    INTEGER DEFAULT 0,
  relationship_count INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kg_tenant ON knowledge_graphs(tenant_id);

-- Agent ↔ Knowledge Graph join
CREATE TABLE IF NOT EXISTS agent_knowledge_graphs (
  agent_id           UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  knowledge_graph_id UUID NOT NULL REFERENCES knowledge_graphs(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, knowledge_graph_id)
);

-- RLS
ALTER TABLE knowledge_graphs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_graphs_tenant_isolation ON knowledge_graphs;
CREATE POLICY knowledge_graphs_tenant_isolation ON knowledge_graphs USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS knowledge_graphs_tenant_insert ON knowledge_graphs;
CREATE POLICY knowledge_graphs_tenant_insert ON knowledge_graphs FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE agent_knowledge_graphs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_knowledge_graphs_tenant_isolation ON agent_knowledge_graphs;
CREATE POLICY agent_knowledge_graphs_tenant_isolation ON agent_knowledge_graphs
  USING (agent_id IN (SELECT id FROM agents WHERE tenant_id = current_tenant_id()));

CREATE INDEX IF NOT EXISTS idx_agent_knowledge_graphs_agent_id ON agent_knowledge_graphs(agent_id);

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_knowledge_graphs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_knowledge_graphs_updated_at ON knowledge_graphs;
CREATE TRIGGER update_knowledge_graphs_updated_at
  BEFORE UPDATE ON knowledge_graphs
  FOR EACH ROW EXECUTE FUNCTION update_knowledge_graphs_updated_at();
