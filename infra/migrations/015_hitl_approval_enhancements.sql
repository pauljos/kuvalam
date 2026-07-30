-- 015_hitl_approval_enhancements.sql
-- Enhanced Human-in-the-Loop approval flow
-- Adds timeout, autonomy tracking, checkpoint columns

-- Add timeout and autonomy tracking to approval_requests
ALTER TABLE approval_requests 
  ADD COLUMN IF NOT EXISTS timeout_minutes INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS autonomy_level VARCHAR(50) DEFAULT 'SUPERVISED',
  ADD COLUMN IF NOT EXISTS auto_rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS modified_input JSONB;

-- Add approval checkpoint to agent_tasks (for resuming after approval)
ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS approval_id UUID REFERENCES approval_requests(id),
  ADD COLUMN IF NOT EXISTS execution_checkpoint JSONB DEFAULT NULL;

-- Index for auto-rejection sweep
CREATE INDEX IF NOT EXISTS idx_approval_auto_reject 
  ON approval_requests(deadline, status) 
  WHERE status = 'PENDING' AND deadline IS NOT NULL;

-- Index for task approval lookup
CREATE INDEX IF NOT EXISTS idx_agent_tasks_approval 
  ON agent_tasks(approval_id) 
  WHERE approval_id IS NOT NULL;

-- Add comment
COMMENT ON COLUMN approval_requests.timeout_minutes IS 'How many minutes before this request auto-rejects';
COMMENT ON COLUMN approval_requests.autonomy_level IS 'The agent autonomy level at time of request';
COMMENT ON COLUMN approval_requests.auto_rejected_at IS 'When the request was auto-rejected due to timeout';
COMMENT ON COLUMN approval_requests.modified_input IS 'Human-modified input parameters (if reviewer adjusts before approving)';
COMMENT ON COLUMN agent_tasks.approval_id IS 'Current pending approval ID (non-null when status = AWAITING_APPROVAL)';
COMMENT ON COLUMN agent_tasks.execution_checkpoint IS 'Serialized execution state for resuming after approval';
