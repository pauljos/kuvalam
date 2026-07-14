// Shared API response types — kept alongside api.ts for now.
// Can be moved to packages/shared once that package is initialized.

export type Uuid = string
export type IsoDate = string

// ─── Auth / User ─────────────────────────────────────────────────────────
export interface User {
  id: Uuid
  email: string
  name?: string | null
  created_at?: IsoDate
  role?: string
}

export interface Tenant {
  id: Uuid
  name: string
  slug?: string
  plan?: 'TRIAL' | 'STARTER' | 'GROWTH' | 'ENTERPRISE' | string
  created_at?: IsoDate
}

export interface LoginResponse {
  user: User
  tenants: Tenant[]
  accessToken?: string
}

// ─── Agents ──────────────────────────────────────────────────────────────
export type AgentStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
export type AutonomyLevel = 'SUPERVISED' | 'GUARDED' | 'AUTONOMOUS'

export interface Agent {
  id: Uuid
  tenant_id: Uuid
  name: string
  description?: string | null
  archetype?: string | null
  status: AgentStatus
  autonomy_level: AutonomyLevel
  llm_provider: string
  llm_model: string
  system_prompt?: string | null
  config?: Record<string, any>
  created_at: IsoDate
  updated_at?: IsoDate
}

// ─── Tasks ───────────────────────────────────────────────────────────────
export type TaskStatus = 'PENDING' | 'RUNNING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export interface Task {
  id: Uuid
  agent_id: Uuid
  goal: string
  status: TaskStatus
  result?: any
  error?: string
  confidence?: number
  tokens_used?: number
  created_at: IsoDate
  completed_at?: IsoDate
}

// ─── Workflows ───────────────────────────────────────────────────────────
export interface Workflow {
  id: Uuid
  tenant_id: Uuid
  name: string
  description?: string | null
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  steps: WorkflowStep[]
  on_failure?: string
  trigger?: { type: string; config?: Record<string, any> }
  created_at: IsoDate
}

export interface WorkflowStep {
  id?: string
  type: 'AGENT_TASK' | 'HTTP' | 'DECISION' | 'DELAY' | 'HUMAN_APPROVAL' | string
  name?: string
  config?: Record<string, any>
}

export interface WorkflowExecution {
  id: Uuid
  workflow_id: Uuid
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  context?: Record<string, any>
  started_at?: IsoDate
  completed_at?: IsoDate
}

// ─── Approvals ───────────────────────────────────────────────────────────
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface Approval {
  id: Uuid
  tenant_id: Uuid
  agent_id?: Uuid
  task_id?: Uuid
  status: ApprovalStatus
  risk_level: RiskLevel
  proposed_action: any
  decision?: string
  decision_note?: string
  decided_by?: Uuid
  decided_at?: IsoDate
  created_at: IsoDate
  expires_at?: IsoDate
}

// ─── Knowledge ───────────────────────────────────────────────────────────
export interface KnowledgeBase {
  id: Uuid
  tenant_id: Uuid
  name: string
  description?: string
  document_count?: number
  created_at: IsoDate
}

export interface KnowledgeDocument {
  id: Uuid
  kb_id: Uuid
  title: string
  source_type: string
  chunk_count?: number
  created_at: IsoDate
}

// ─── Triggers ────────────────────────────────────────────────────────────
export type TriggerType = 'WEBHOOK' | 'SCHEDULE' | 'EVENT' | 'CONDITION'

export interface Trigger {
  id: Uuid
  tenant_id: Uuid
  name: string
  type: TriggerType
  is_active: boolean
  workflow_id?: Uuid
  agent_id?: Uuid
  config?: Record<string, any>
  webhook_secret?: string
  last_fired_at?: IsoDate
  fire_count?: number
  created_at: IsoDate
}

// ─── MCP ─────────────────────────────────────────────────────────────────
export interface McpServer {
  id: Uuid
  name: string
  url: string
  transport: 'http' | 'sse' | 'stdio' | string
  tool_count?: number
  auth_type?: string
  created_at?: IsoDate
}

// ─── Feedback ────────────────────────────────────────────────────────────
export interface Feedback {
  id: Uuid
  tenant_id: Uuid
  approval_id?: Uuid
  agent_id?: Uuid
  decision?: string
  quality_rating: 1 | 2 | 3 | 4 | 5
  feedback_text?: string
  feedback_tags?: string[]
  decided_by?: Uuid
  created_at: IsoDate
}

// ─── Profile ─────────────────────────────────────────────────────────────
export interface Profile {
  id: Uuid
  email: string
  name?: string | null
  created_at: IsoDate
  role?: string
}

// ─── Common list envelopes ───────────────────────────────────────────────
export interface AgentsListResponse { agents: Agent[]; total?: number }
export interface WorkflowsListResponse { workflows: Workflow[]; total?: number }
export interface ApprovalsListResponse { approvals: Approval[]; total?: number }
export interface TasksListResponse { tasks: Task[]; total?: number }
export interface FeedbackListResponse { feedback: Feedback[]; averageRating?: number | null; total?: number }
