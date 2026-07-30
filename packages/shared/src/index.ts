// ─── Canonical Kuvalam Types ─────────────────────────────────────────────
// Single source of truth for domain types used by both API (Fastify/Node)
// and frontend (Next.js/React).
//
// Import from '@kuvalam/shared' after wiring tsconfig paths:
//   "paths": { "@kuvalam/shared": ["packages/shared/src"] }

export type Uuid = string
export type IsoDate = string  // ISO-8601 string
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// ─── Enums ───────────────────────────────────────────────────────────────
export type AgentStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
export type AutonomyLevel = 'SUPERVISED' | 'GUARDED' | 'AUTONOMOUS'
export type TaskStatus = 'PENDING' | 'RUNNING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type WorkflowStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
export type WorkflowExecutionStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type TriggerType = 'WEBHOOK' | 'SCHEDULE' | 'EVENT' | 'CONDITION'
export type FeedbackRating = 1 | 2 | 3 | 4 | 5
export type PlanTier = 'TRIAL' | 'STARTER' | 'GROWTH' | 'ENTERPRISE'
export type MCPTransport = 'http' | 'sse' | 'stdio'

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
  plan?: PlanTier | string
  created_at?: IsoDate
}

export interface LoginResponse {
  user: User
  tenants: Tenant[]
  accessToken?: string
}

// ─── Agents ──────────────────────────────────────────────────────────────
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
  status: WorkflowStatus
  steps: WorkflowStep[]
  on_failure?: string
  trigger?: WorkflowTrigger
  created_at: IsoDate
}

export interface WorkflowStep {
  id?: string
  type: 'AGENT_TASK' | 'HTTP' | 'DECISION' | 'DELAY' | 'HUMAN_APPROVAL' | string
  name?: string
  config?: Record<string, any>
}

export interface WorkflowTrigger {
  type: string
  config?: Record<string, any>
}

export interface WorkflowExecution {
  id: Uuid
  workflow_id: Uuid
  status: WorkflowExecutionStatus
  context?: Record<string, any>
  started_at?: IsoDate
  completed_at?: IsoDate
}

// ─── Approvals ───────────────────────────────────────────────────────────
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

// ─── Connectors ──────────────────────────────────────────────────────────
export interface Connector {
  id: Uuid
  tenant_id: Uuid
  tool_id?: string          // maps to a built-in tool (e.g. 'send_email', 'google_calendar')
  name: string
  provider: string          // e.g. 'GOOGLE_GMAIL', 'SENDGRID', 'SLACK', 'HUBSPOT', 'DATABASE'
  status: 'ACTIVE' | 'INACTIVE' | 'ERROR' | string
  config?: Record<string, any>  // decrypted on read
  error_info?: string | null
  created_by?: Uuid
  created_at: IsoDate
  updated_at?: IsoDate
}

export interface OAuthApp {
  id?: Uuid
  tenant_id: Uuid
  provider: string
  client_id: string
  client_secret_enc: string
  redirect_uri?: string
  created_by?: Uuid
  created_at?: IsoDate
}

// ─── MCP Servers ─────────────────────────────────────────────────────────
export interface McpServer {
  id: Uuid
  name: string
  url: string
  transport: MCPTransport | string
  tool_count?: number
  auth_type?: string
  status?: 'ACTIVE' | 'INACTIVE'
  created_at?: IsoDate
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
export interface Trigger {
  id: Uuid
  tenant_id: Uuid
  name: string
  type: TriggerType
  is_active: boolean
  workflow_id?: Uuid
  agent_id?: Uuid
  config?: Record<string, any>
  webhook_secret?: string  // encrypted in DB, never returned in lists
  last_fired_at?: IsoDate
  fire_count?: number
  created_at: IsoDate
}

// ─── Feedback ────────────────────────────────────────────────────────────
export interface Feedback {
  id: Uuid
  tenant_id: Uuid
  approval_id?: Uuid
  agent_id?: Uuid
  decision?: string
  quality_rating: FeedbackRating
  feedback_text?: string
  feedback_tags?: string[]
  decided_by?: Uuid
  created_at: IsoDate
}

// ─── Settings ────────────────────────────────────────────────────────────
export interface LLMProviderConfig {
  provider: string       // e.g. 'openai', 'anthropic', 'groq', 'ollama', 'huggingface'
  model: string
  apiKey?: string         // encrypted in DB, masked in response
  baseUrl?: string        // custom endpoint for local/Ollama
  isLocal?: boolean       // auto-resolved from provider type
}

export interface TenantSettings {
  llm_providers?: LLMProviderConfig[]
  default_provider?: string
}

// ─── Tools & Skills ──────────────────────────────────────────────────────
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    required?: string[]
    properties: Record<string, {
      type: string
      enum?: string[]
      description?: string
      default?: JsonValue
      items?: { type: string }
    }>
  }
  /** Internal connector ID (set by getConnectorToolDefinitions) */
  _connectorId?: Uuid
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string  // JSON-encoded string
  }
}

export interface AgentSkill {
  id: Uuid
  agent_id: Uuid
  name: string
  description?: string
  is_enabled: boolean
  config?: {
    inputSchema?: ToolDefinition['inputSchema']
    [key: string]: JsonValue
  }
  created_at?: IsoDate
}

// ─── Dashboard Reports ───────────────────────────────────────────────────
export interface DashboardReport {
  id: Uuid
  tenant_id: Uuid
  agent_id?: Uuid
  title: string
  body?: string            // HTML content
  sql?: string
  db_id?: string
  chart_type?: string
  is_favourite?: boolean
  created_at: IsoDate
  updated_at?: IsoDate
}

// ─── Chat ────────────────────────────────────────────────────────────────
export interface ChatConversation {
  id: Uuid
  tenant_id: Uuid
  agent_id?: Uuid
  title?: string
  created_at: IsoDate
  updated_at?: IsoDate
}

export interface ChatMessage {
  id: Uuid
  conversation_id: Uuid
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  created_at: IsoDate
}

// ─── Memory ──────────────────────────────────────────────────────────────
export interface MemoryEntry {
  id: Uuid
  agent_id: Uuid
  tenant_id: Uuid
  task_id?: Uuid
  task_type?: string
  goal_summary: string
  outcome: 'SUCCESS' | 'FAILURE' | string
  key_actions: string[]
  result_summary?: string
  created_at: IsoDate
}

// ─── Audit ───────────────────────────────────────────────────────────────
export interface AuditLogEntry {
  id: Uuid
  tenant_id: Uuid
  event_type: string
  actor_id?: Uuid
  actor_type?: 'USER' | 'AGENT' | 'SYSTEM' | string
  resource_type?: string
  resource_id?: Uuid
  action: string
  metadata?: JsonObject
  before_state?: JsonObject
  after_state?: JsonObject
  created_at: IsoDate
}

// ─── Telemetry ───────────────────────────────────────────────────────────
export interface TelemetryEvent {
  event: string
  tenantId: Uuid
  data: {
    taskId?: Uuid
    agentId?: Uuid
    agentName?: string
    phase?: string
    label?: string
    token?: string
    actionIdx?: number
    tool?: string
    success?: boolean
    output?: JsonObject
    confidence?: number
    tokensUsed?: number
    durationMs?: number
    error?: string
    resume?: boolean
  }
  timestamp: IsoDate
}

// ─── Agent Execution ─────────────────────────────────────────────────────
export interface ExecutionContext {
  isTrainedModel: boolean
  hasDb: boolean
  activeDbName: string
  activeDbStatus: string
  allDbConnections: string[]
  toolCount: number
  hasDbTools: boolean
  hasHttp: boolean
  hasBrowser: boolean
  hasPublish: boolean
  connectorToolCount: number
  mcpToolCount: number
  customSkillCount: number
  knowledgeBaseNames: string[]
}

// ─── Knowledge Graph ─────────────────────────────────────────────────────
export interface KnowledgeGraphNode {
  id: string
  label: string
  type: string
  properties?: JsonObject
}

export interface KnowledgeGraphEdge {
  source: string
  target: string
  relationship: string
  properties?: JsonObject
}

// ─── Triggers (extended) ─────────────────────────────────────────────────
export interface ScheduledTrigger {
  type: 'SCHEDULE'
  config: { cron: string; timezone?: string }
}

export interface WebhookTriggerPayload {
  type: 'WEBHOOK'
  config: { secret: string; url?: string }
  payload?: JsonObject
}

export interface ConditionTrigger {
  type: 'CONDITION'
  config: { field: string; operator: string; value: JsonValue }
}

// ─── Rate Limiting ───────────────────────────────────────────────────────
export interface RateLimitConfig {
  windowMs: number       // time window in milliseconds
  maxRequests: number    // max requests per window
  keyPrefix?: string     // Redis key prefix
  skipFailedRequests?: boolean
}

// ─── Common API envelopes ────────────────────────────────────────────────
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface PaginatedResponse<T> {
  success: boolean
  data: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface ApiError {
  code: string
  message: string
  statusCode: number
  details?: JsonObject
}

// ─── Domain list responses ───────────────────────────────────────────────
export interface AgentsListResponse       { agents: Agent[]; total?: number }
export interface WorkflowsListResponse    { workflows: Workflow[]; total?: number }
export interface ApprovalsListResponse    { approvals: Approval[]; total?: number }
export interface TasksListResponse        { tasks: Task[]; total?: number }
export interface FeedbackListResponse     { feedback: Feedback[]; averageRating?: number | null; total?: number }
export interface ConnectorsListResponse   { connectors: Connector[]; total?: number }
export interface McpServersListResponse   { servers: McpServer[] }
export interface TriggersListResponse     { triggers: Trigger[]; total?: number }
export interface KnowledgeBasesListResp   { knowledgeBases: KnowledgeBase[] }

// ─── Runtime guard (optional, tree-shakeable) ────────────────────────────
export function isValidAgentStatus(s: string): s is AgentStatus {
  return ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].includes(s)
}

export function isValidAutonomyLevel(l: string): l is AutonomyLevel {
  return ['SUPERVISED', 'GUARDED', 'AUTONOMOUS'].includes(l)
}

export function isValidTaskStatus(s: string): s is TaskStatus {
  return ['PENDING', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(s)
}
