-- Enable RLS on all remaining tenant-scoped tables
-- Migration 012: Complete RLS coverage for enterprise multi-tenancy

-- Agent-related tables
ALTER TABLE agent_episodic_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_scopes ENABLE ROW LEVEL SECURITY;

-- Chat tables
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Dashboard & reports
ALTER TABLE dashboard_reports ENABLE ROW LEVEL SECURITY;

-- Workflow tables
ALTER TABLE step_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_triggers ENABLE ROW LEVEL SECURITY;

-- Auth tables (special handling - users/tenants are global but need policies)
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Agent tables - tenant isolation via agent_id → agents.tenant_id
CREATE POLICY agent_episodic_memory_tenant_isolation ON agent_episodic_memory
  USING (agent_id IN (SELECT id FROM agents WHERE tenant_id = current_setting('app.current_tenant_id')::UUID));

CREATE POLICY agent_knowledge_bases_tenant_isolation ON agent_knowledge_bases
  USING (agent_id IN (SELECT id FROM agents WHERE tenant_id = current_setting('app.current_tenant_id')::UUID));

CREATE POLICY agent_memory_tenant_isolation ON agent_memory
  USING (agent_id IN (SELECT id FROM agents WHERE tenant_id = current_setting('app.current_tenant_id')::UUID));

CREATE POLICY agent_rules_tenant_isolation ON agent_rules
  USING (agent_id IN (SELECT id FROM agents WHERE tenant_id = current_setting('app.current_tenant_id')::UUID));

CREATE POLICY agent_skills_tenant_isolation ON agent_skills
  USING (agent_id IN (SELECT id FROM agents WHERE tenant_id = current_setting('app.current_tenant_id')::UUID));

CREATE POLICY agent_tool_scopes_tenant_isolation ON agent_tool_scopes
  USING (agent_id IN (SELECT id FROM agents WHERE tenant_id = current_setting('app.current_tenant_id')::UUID));

-- Chat tables - tenant isolation via tenant_id
CREATE POLICY chat_conversations_tenant_isolation ON chat_conversations
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY chat_messages_tenant_isolation ON chat_messages
  USING (conversation_id IN (SELECT id FROM chat_conversations WHERE tenant_id = current_setting('app.current_tenant_id')::UUID));

-- Dashboard reports - tenant isolation via tenant_id
CREATE POLICY dashboard_reports_tenant_isolation ON dashboard_reports
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Workflow tables - tenant isolation via execution_id → workflow_executions.workflow_id → workflows.tenant_id
CREATE POLICY step_executions_tenant_isolation ON step_executions
  USING (execution_id IN (
    SELECT id FROM workflow_executions 
    WHERE workflow_id IN (SELECT id FROM workflows WHERE tenant_id = current_setting('app.current_tenant_id')::UUID)
  ));

CREATE POLICY workflow_triggers_tenant_isolation ON workflow_triggers
  USING (workflow_id IN (SELECT id FROM workflows WHERE tenant_id = current_setting('app.current_tenant_id')::UUID));

-- Refresh tokens - user can only see their own tokens
CREATE POLICY refresh_tokens_user_isolation ON refresh_tokens
  USING (user_id = current_setting('app.current_user_id')::UUID);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES for RLS performance
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_agent_episodic_memory_agent_id ON agent_episodic_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_bases_agent_id ON agent_knowledge_bases(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent_id ON agent_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_rules_agent_id ON agent_rules(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_skills_agent_id ON agent_skills(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_scopes_agent_id ON agent_tool_scopes(agent_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_tenant_id ON chat_conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_reports_tenant_id ON dashboard_reports(tenant_id);
CREATE INDEX IF NOT EXISTS idx_step_executions_execution_id ON step_executions(execution_id);
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_workflow_id ON workflow_triggers(workflow_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
