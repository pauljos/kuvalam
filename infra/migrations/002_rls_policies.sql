-- ============================================================
-- Kuvalam Platform — Row-Level Security (RLS) Policies
-- Migration: 002_rls_policies.sql
-- Phase 3: Production Hardening
-- ============================================================

-- ─── Helper: Application role for API connections ──────────────
-- The API sets `app.current_tenant_id` on each connection via:
--   SET LOCAL app.current_tenant_id = '<uuid>';

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
$$ LANGUAGE SQL STABLE;

-- ─── Enable RLS and Create Policies (Idempotent) ───────────────

-- Agents
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agents_tenant_isolation ON agents;
CREATE POLICY agents_tenant_isolation ON agents USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS agents_tenant_insert ON agents;
CREATE POLICY agents_tenant_insert ON agents FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Agent Tasks
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_tasks_tenant_isolation ON agent_tasks;
CREATE POLICY agent_tasks_tenant_isolation ON agent_tasks USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS agent_tasks_tenant_insert ON agent_tasks;
CREATE POLICY agent_tasks_tenant_insert ON agent_tasks FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Workflows
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflows_tenant_isolation ON workflows;
CREATE POLICY workflows_tenant_isolation ON workflows USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS workflows_tenant_insert ON workflows;
CREATE POLICY workflows_tenant_insert ON workflows FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Workflow Executions
ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_executions_tenant_isolation ON workflow_executions;
CREATE POLICY workflow_executions_tenant_isolation ON workflow_executions USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS workflow_executions_tenant_insert ON workflow_executions;
CREATE POLICY workflow_executions_tenant_insert ON workflow_executions FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Knowledge Bases
ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_bases_tenant_isolation ON knowledge_bases;
CREATE POLICY knowledge_bases_tenant_isolation ON knowledge_bases USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS knowledge_bases_tenant_insert ON knowledge_bases;
CREATE POLICY knowledge_bases_tenant_insert ON knowledge_bases FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Knowledge Documents
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_documents_tenant_isolation ON knowledge_documents;
CREATE POLICY knowledge_documents_tenant_isolation ON knowledge_documents USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS knowledge_documents_tenant_insert ON knowledge_documents;
CREATE POLICY knowledge_documents_tenant_insert ON knowledge_documents FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Knowledge Chunks
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_chunks_tenant_isolation ON knowledge_chunks;
CREATE POLICY knowledge_chunks_tenant_isolation ON knowledge_chunks USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS knowledge_chunks_tenant_insert ON knowledge_chunks;
CREATE POLICY knowledge_chunks_tenant_insert ON knowledge_chunks FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Knowledge Chunk Embeddings
ALTER TABLE knowledge_chunk_embeddings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_chunk_embeddings_tenant_isolation ON knowledge_chunk_embeddings;
CREATE POLICY knowledge_chunk_embeddings_tenant_isolation ON knowledge_chunk_embeddings USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS knowledge_chunk_embeddings_tenant_insert ON knowledge_chunk_embeddings;
CREATE POLICY knowledge_chunk_embeddings_tenant_insert ON knowledge_chunk_embeddings FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Tool Connections
ALTER TABLE tool_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tool_connections_tenant_isolation ON tool_connections;
CREATE POLICY tool_connections_tenant_isolation ON tool_connections USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS tool_connections_tenant_insert ON tool_connections;
CREATE POLICY tool_connections_tenant_insert ON tool_connections FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Approval Requests
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_requests_tenant_isolation ON approval_requests;
CREATE POLICY approval_requests_tenant_isolation ON approval_requests USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS approval_requests_tenant_insert ON approval_requests;
CREATE POLICY approval_requests_tenant_insert ON approval_requests FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Human Feedback
ALTER TABLE human_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS human_feedback_tenant_isolation ON human_feedback;
CREATE POLICY human_feedback_tenant_isolation ON human_feedback USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS human_feedback_tenant_insert ON human_feedback;
CREATE POLICY human_feedback_tenant_insert ON human_feedback FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Audit Log (read-only isolation; inserts bypass for system logging)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_read ON audit_log;
CREATE POLICY audit_log_tenant_read ON audit_log FOR SELECT USING (tenant_id = current_tenant_id() OR tenant_id IS NULL);
DROP POLICY IF EXISTS audit_log_allow_insert ON audit_log;
CREATE POLICY audit_log_allow_insert ON audit_log FOR INSERT WITH CHECK (true);

-- Tenant Members
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_members_tenant_isolation ON tenant_members;
CREATE POLICY tenant_members_tenant_isolation ON tenant_members USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS tenant_members_tenant_insert ON tenant_members;
CREATE POLICY tenant_members_tenant_insert ON tenant_members FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- ─── Create a non-superuser role for the app ──────────────────
-- NOTE: Set the password securely after running this migration:
--   ALTER ROLE kuvalam_app PASSWORD '<strong-random-password>';
-- Or use a secrets manager / IAM-based auth in production.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kuvalam_app') THEN
    CREATE ROLE kuvalam_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO kuvalam_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kuvalam_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kuvalam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kuvalam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO kuvalam_app;

SELECT 'RLS policies activated on all tenant-scoped tables' AS status;
