-- 007_performance_indexes.sql
-- Add indexes to improve query performance

-- Users table indexes
CREATE INDEX IF NOT EXISTS idx_users_is_system_admin ON users(is_system_admin) WHERE is_system_admin = true;
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at DESC);

-- Tenant members - most queried for auth checks
CREATE INDEX IF NOT EXISTS idx_tenant_members_user_tenant ON tenant_members(user_id, tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant_role ON tenant_members(tenant_id, role, status);

-- Agents - frequently listed (only if table exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'agents') THEN
    CREATE INDEX IF NOT EXISTS idx_agents_tenant_status ON agents(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_agents_tenant_created ON agents(tenant_id, created_at DESC);
  END IF;
END $$;

-- Agent tasks - filtered by status often (only if table exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'agent_tasks') THEN
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_status ON agent_tasks(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_tenant_status ON agent_tasks(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_created ON agent_tasks(created_at DESC);
  END IF;
END $$;

-- Workflows - listed frequently (only if table exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'workflows') THEN
    CREATE INDEX IF NOT EXISTS idx_workflows_tenant_status ON workflows(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflows_tenant_created ON workflows(tenant_id, created_at DESC);
  END IF;
END $$;

-- Workflow executions - filtered by status (only if table exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'workflow_executions') THEN
    CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow_status ON workflow_executions(workflow_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_executions_tenant_status ON workflow_executions(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_executions_started ON workflow_executions(started_at DESC);
  END IF;
END $$;

-- Approvals - filtered by status frequently (only if table exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'approvals') THEN
    CREATE INDEX IF NOT EXISTS idx_approvals_tenant_status ON approvals(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_created ON approvals(created_at DESC);
  END IF;
END $$;

-- Audit log - time-series queries (only if table exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'audit_log') THEN
    CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_time ON audit_log(tenant_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id, timestamp DESC);
  END IF;
END $$;

-- Knowledge bases (only if table exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'knowledge_bases') THEN
    CREATE INDEX IF NOT EXISTS idx_knowledge_bases_tenant ON knowledge_bases(tenant_id, created_at DESC);
  END IF;
END $$;

DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'knowledge_documents') THEN
    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kb ON knowledge_documents(knowledge_base_id, created_at DESC);
  END IF;
END $$;

DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'knowledge_chunks') THEN
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id);
  END IF;
END $$;

-- Connectors (only if table exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'connectors') THEN
    CREATE INDEX IF NOT EXISTS idx_connectors_tenant_provider ON connectors(tenant_id, provider);
    CREATE INDEX IF NOT EXISTS idx_connectors_tenant_status ON connectors(tenant_id, status);
  END IF;
END $$;

-- Triggers (only if table exists)
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'workflow_triggers') THEN
    CREATE INDEX IF NOT EXISTS idx_workflow_triggers_tenant_active ON workflow_triggers(tenant_id, is_active, trigger_type);
    CREATE INDEX IF NOT EXISTS idx_workflow_triggers_workflow ON workflow_triggers(workflow_id, is_active);
  END IF;
END $$;

-- Refresh tokens - cleanup queries
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, expires_at) WHERE revoked = false;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at) WHERE revoked = false;

-- Composite index for common auth query
DO $$ 
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'tenant_members') THEN
    CREATE INDEX IF NOT EXISTS idx_tenant_members_lookup ON tenant_members(user_id, status, tenant_id) 
      INCLUDE (role) WHERE status = 'ACTIVE';
  END IF;
END $$;

