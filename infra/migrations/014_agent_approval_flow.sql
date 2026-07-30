-- Add columns for HITL agent approval flow
-- Migration 014: Agent approval flow support

ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS tool_name VARCHAR(255);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS tool_input JSONB;

-- Make deadline optional (we'll use timeout in code instead)
ALTER TABLE approval_requests ALTER COLUMN deadline DROP NOT NULL;

-- Add index for agent lookups
CREATE INDEX IF NOT EXISTS idx_approval_agent ON approval_requests(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_task ON approval_requests(task_id, status);

-- Add comment
COMMENT ON COLUMN approval_requests.tool_name IS 'Name of the tool that requires approval (e.g., ssh_exec, docker_run)';
COMMENT ON COLUMN approval_requests.tool_input IS 'Input parameters for the tool call';
COMMENT ON COLUMN approval_requests.agent_id IS 'Agent requesting the approval';
