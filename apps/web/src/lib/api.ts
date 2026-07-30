// src/lib/api.ts — API client
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
export const API = API_BASE.endsWith('/api/v1') ? API_BASE : `${API_BASE}/api/v1`

// Re-export shared API types so consumers can `import { Agent } from '@/lib/api'`
export * from './api-types'

// Coalesce concurrent refresh calls so we only hit /auth/refresh once even
// when a page fires ten API calls in parallel and they all 401 together.
let refreshInFlight: Promise<boolean> | null = null

async function tryRefreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      // Refresh using httpOnly cookie only (no localStorage tokens)
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      
      return res.ok
    } catch {
      return false
    } finally {
      // Release the lock a tick later so any concurrent 401s share the same result
      setTimeout(() => { refreshInFlight = null }, 0)
    }
  })()
  return refreshInFlight
}

async function request(path: string, options: RequestInit = {}, _isRetry = false): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  }

  // Use httpOnly cookies only (no Authorization header from localStorage)
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers,
    credentials: 'include', // sends the httpOnly kuvalam_token cookie automatically
  })

  // On expired access token, try to silently mint a new one via the refresh
  // cookie, then replay the original request exactly once. This makes the
  // 15-minute JWT invisible to users \u2014 sessions feel like they last 30 days.
  if (res.status === 401 && !_isRetry && !path.startsWith('/auth/')) {
    console.log('Token expired, attempting refresh...')
    const refreshed = await tryRefreshSession()
    console.log('Refresh result:', refreshed)
    if (refreshed) return request(path, options, true)
  }

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      // Don't auto-logout if accessing admin routes (might be permission issue, not auth)
      if (!path.startsWith('/admin/')) {
        console.warn('Session expired or unauthorized. Redirecting to login.')
        localStorage.removeItem('kuvalam_user')
        localStorage.removeItem('kuvalam_tenants')
        localStorage.removeItem('kuvalam_tenant_id')
        localStorage.removeItem('kuvalam_tenant')
        window.location.href = '/'
      } else {
        // For admin routes, show the error without logging out
        console.error('Admin access denied:', data.error)
      }
    }
    const err = new Error(data.error?.message || 'Request failed')
    ;(err as any).code = data.error?.code
    ;(err as any).status = res.status
    ;(err as any).details = data.error?.details
    throw err
  }

  // Guard: some endpoints return HTTP 200 but { success: false, error: {...} }
  if (data.success === false) {
    const err = new Error(data.error?.message || 'Request failed')
    ;(err as any).code = data.error?.code
    ;(err as any).status = res.status
    ;(err as any).details = data.error?.details
    throw err
  }

  return data.data
}

// Public helper for pages that use raw fetch() (file uploads, custom
// response handling, etc.) but still want the silent-refresh behaviour.
// On a 401, it transparently refreshes the session cookie and retries once.
export async function authedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const opts: RequestInit = { credentials: 'include', ...init }
  const res = await fetch(input, opts)
  if (res.status !== 401) return res
  const refreshed = await tryRefreshSession()
  if (!refreshed) return res
  return fetch(input, opts)
}

export const api = {
  // Generic request helper for custom endpoints
  request: (path: string, options?: RequestInit) => request(path, options),
  
  // Auth
  register: (body: any) => request('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: any) => request('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),

  // Tenants
  createTenant: (body: any) => request('/tenants', { method: 'POST', body: JSON.stringify(body) }),
  getTenant: (id: string) => request(`/tenants/${id}`),
  updateTenant: (id: string, body: any) => request(`/tenants/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  getMembers: (tenantId: string) => request(`/tenants/${tenantId}/members`),
  inviteMember: (tenantId: string, body: any) => request(`/tenants/${tenantId}/members/invite`, { method: 'POST', body: JSON.stringify(body) }),

  // Custom Models (Fine-Tuning)
  getCustomModels: (tenantId: string) => request(`/tenants/${tenantId}/custom-models`),
  getCustomModel: (tenantId: string, modelId: string) => request(`/tenants/${tenantId}/custom-models/${modelId}`),
  trainCustomModel: (tenantId: string, body: any) => request(`/tenants/${tenantId}/custom-models`, { method: 'POST', body: JSON.stringify(body) }),
  cancelTraining: (tenantId: string, modelId: string) => request(`/tenants/${tenantId}/custom-models/${modelId}/cancel`, { method: 'POST', body: '{}' }),
  getOllamaAvailableModels: (tenantId: string) => request(`/tenants/${tenantId}/custom-models/ollama/available`).catch(() => ({ models: [] })),
  
  // Dashboard Reports
  getReports: (tenantId: string) => request(`/tenants/${tenantId}/reports`),
  getReport: (tenantId: string, reportId: string) => request(`/tenants/${tenantId}/reports/${reportId}`),
  deleteReport: (tenantId: string, reportId: string) => request(`/tenants/${tenantId}/reports/${reportId}`, { method: 'DELETE' }),
  getReportDownloadUrl: (tenantId: string, reportId: string, format: string) =>
    `${API}/tenants/${tenantId}/reports/${reportId}/download?format=${format}`,
  shareReport: (tenantId: string, reportId: string) => request(`/tenants/${tenantId}/reports/${reportId}/share`, { method: 'POST' }),
  revokeShareLink: (tenantId: string, reportId: string) => request(`/tenants/${tenantId}/reports/${reportId}/share`, { method: 'DELETE' }),
  archiveReport: (tenantId: string, reportId: string) => request(`/tenants/${tenantId}/reports/${reportId}/archive`, { method: 'POST' }),

  // Task Outputs (completed agent task results, pinnable to reports)
  getTaskOutputs: (tenantId: string, params?: { status?: string; agentId?: string; page?: number }) => {
    const qs = params ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([_, v]) => v != null)) as Record<string, string>).toString() : ''
    return request(`/tenants/${tenantId}/task-outputs${qs}`)
  },
  pinTaskOutput: (tenantId: string, taskId: string, body?: { title?: string }) =>
    request(`/tenants/${tenantId}/task-outputs/${taskId}/pin`, { method: 'POST', body: JSON.stringify(body || {}) }),
  deleteTaskOutput: (tenantId: string, taskId: string) =>
    request(`/tenants/${tenantId}/task-outputs/${taskId}`, { method: 'DELETE' }),

  testDbConnection: (tenantId: string, body: any) => request(`/tenants/${tenantId}/custom-models/test-db-connection`, { method: 'POST', body: JSON.stringify(body) }),

  // Agents
  createAgent: (tenantId: string, body: any) => request(`/tenants/${tenantId}/agents`, { method: 'POST', body: JSON.stringify(body) }),
  listAgents: (tenantId: string) => request(`/tenants/${tenantId}/agents`),
  getAgent: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}`),
  updateAgent: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAgent: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}`, { method: 'DELETE' }),
  activateAgent: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}/activate`, { method: 'POST', body: '{}' }),
  addSkill: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/skills`, { method: 'POST', body: JSON.stringify(body) }),
  removeSkill: (tenantId: string, agentId: string, skillId: string) => request(`/tenants/${tenantId}/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' }),
  testSkill: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/test-skill`, { method: 'POST', body: JSON.stringify(body) }),
  addRule: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/rules`, { method: 'POST', body: JSON.stringify(body) }),
  removeRule: (tenantId: string, agentId: string, ruleId: string) => request(`/tenants/${tenantId}/agents/${agentId}/rules/${ruleId}`, { method: 'DELETE' }),
  linkKnowledgeBase: (tenantId: string, agentId: string, kbId: string) => request(`/tenants/${tenantId}/agents/${agentId}/knowledge-bases/${kbId}`, { method: 'POST' }),
  unlinkKnowledgeBase: (tenantId: string, agentId: string, kbId: string) => request(`/tenants/${tenantId}/agents/${agentId}/knowledge-bases/${kbId}`, { method: 'DELETE' }),
  dispatchTask: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  listTasks: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}/tasks`),
  getTask: (tenantId: string, agentId: string, taskId: string) => request(`/tenants/${tenantId}/agents/${agentId}/tasks/${taskId}`),
  cancelTask: (tenantId: string, agentId: string, taskId: string) => request(`/tenants/${tenantId}/agents/${agentId}/tasks/${taskId}/cancel`, { method: 'POST', body: '{}' }),
  deleteTask: (tenantId: string, agentId: string, taskId: string) => request(`/tenants/${tenantId}/agents/${agentId}/tasks/${taskId}`, { method: 'DELETE' }),
  linkKB: (tenantId: string, agentId: string, kbId: string) => request(`/tenants/${tenantId}/agents/${agentId}/knowledge-bases/${kbId}`, { method: 'POST', body: '{}' }),

  // Knowledge
  createKB: (tenantId: string, body: any) => request(`/tenants/${tenantId}/knowledge-bases`, { method: 'POST', body: JSON.stringify(body) }),
  listKBs: (tenantId: string) => request(`/tenants/${tenantId}/knowledge-bases`),
  getKB: (tenantId: string, kbId: string) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}`),
  deleteKB: (tenantId: string, kbId: string) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}`, { method: 'DELETE' }),
  addDocument: (tenantId: string, kbId: string, body: any) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/documents`, { method: 'POST', body: JSON.stringify(body) }),
  deleteDocument: (tenantId: string, kbId: string, docId: string) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/documents/${docId}`, { method: 'DELETE' }),
  listDocuments: (tenantId: string, kbId: string) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/documents`),
  searchKB: (tenantId: string, kbId: string, body: any) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/search`, { method: 'POST', body: JSON.stringify(body) }),
  reprocessDocument: (tenantId: string, kbId: string, docId: string) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/documents/${docId}/reprocess`, { method: 'POST', body: '{}' }),
  reprocessKB: (tenantId: string, kbId: string) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/reprocess-all`, { method: 'POST', body: '{}' }),
  getKBDBSchema: (tenantId: string, kbId: string, connectionId?: string) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/db-schema${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`),
  importKBFromDB: (tenantId: string, kbId: string, body: any) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/import-from-db`, { method: 'POST', body: JSON.stringify(body) }),

  // Knowledge Graphs
  listKnowledgeGraphs: (tenantId: string) => request(`/tenants/${tenantId}/knowledge-graphs`),
  createKnowledgeGraph: (tenantId: string, body: any) => request(`/tenants/${tenantId}/knowledge-graphs`, { method: 'POST', body: JSON.stringify(body) }),
  deleteKnowledgeGraph: (tenantId: string, graphId: string) => request(`/tenants/${tenantId}/knowledge-graphs/${graphId}`, { method: 'DELETE' }),
  linkKnowledgeGraph: (tenantId: string, agentId: string, graphId: string) => request(`/tenants/${tenantId}/agents/${agentId}/knowledge-graphs/${graphId}`, { method: 'POST', body: '{}' }),
  unlinkKnowledgeGraph: (tenantId: string, agentId: string, graphId: string) => request(`/tenants/${tenantId}/agents/${agentId}/knowledge-graphs/${graphId}`, { method: 'DELETE' }),
  getDBSources: (tenantId: string) => request(`/tenants/${tenantId}/db-sources`),
  getGraphDBSchema: (tenantId: string, graphId: string, connectionId?: string) => request(`/tenants/${tenantId}/knowledge-graphs/${graphId}/db-schema${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`),
  importGraphFromDB: (tenantId: string, graphId: string, body: any) => request(`/tenants/${tenantId}/knowledge-graphs/${graphId}/import-from-db`, { method: 'POST', body: JSON.stringify(body) }),
  addGraphEntity: (tenantId: string, graphId: string, body: any) => request(`/tenants/${tenantId}/knowledge-graphs/${graphId}/entities`, { method: 'POST', body: JSON.stringify(body) }),
  listGraphEntities: (tenantId: string, graphId: string) => request(`/tenants/${tenantId}/knowledge-graphs/${graphId}/entities`),
  deleteGraphEntity: (tenantId: string, graphId: string, entityLabel: string) => request(`/tenants/${tenantId}/knowledge-graphs/${graphId}/entities/${encodeURIComponent(entityLabel)}`, { method: 'DELETE' }),

  // Settings
  getSettings: (tenantId: string) => request(`/tenants/${tenantId}/settings`),
  saveLLMConfig: (tenantId: string, body: any) => request(`/tenants/${tenantId}/settings/llm`, { method: 'PUT', body: JSON.stringify(body) }),
  removeLLMProvider: (tenantId: string, provider: string) => request(`/tenants/${tenantId}/settings/llm/${provider}`, { method: 'DELETE' }),
  testLLMProvider: (tenantId: string, body: any) => request(`/tenants/${tenantId}/settings/llm/test`, { method: 'POST', body: JSON.stringify(body) }),
  saveGeneralSettings: (tenantId: string, body: any) => request(`/tenants/${tenantId}/settings/general`, { method: 'PUT', body: JSON.stringify(body) }),

  // System Scan (local deployment dependency checker)
  systemScan: (tenantId: string) => request(`/tenants/${tenantId}/system/scan`),
  systemInstall: (tenantId: string, depId: string) => request(`/tenants/${tenantId}/system/install`, { method: 'POST', body: JSON.stringify({ depId }) }),

  // Knowledge Infrastructure (local Docker provisioning for vector DB + graph DB)
  getKnowledgeInfraStatus: (tenantId: string) => request(`/tenants/${tenantId}/knowledge-infra/status`),
  startKnowledgeService: (tenantId: string, service: string) => request(`/tenants/${tenantId}/knowledge-infra/start`, { method: 'POST', body: JSON.stringify({ service }) }),
  createInfraConnector: (tenantId: string, service: string) => request(`/tenants/${tenantId}/knowledge-infra/create-connector`, { method: 'POST', body: JSON.stringify({ service }) }),

  // Agent prompt preview
  previewAgentPrompt: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}/preview-prompt`),

  // Workflows
  listWorkflows: (tenantId: string) => request(`/tenants/${tenantId}/workflows`),
  listWorkflowExecutions: (tenantId: string) => request(`/tenants/${tenantId}/workflows/executions`),
  createWorkflow: (tenantId: string, body: any) => request(`/tenants/${tenantId}/workflows`, { method: 'POST', body: JSON.stringify(body) }),
  getWorkflow: (tenantId: string, id: string) => request(`/tenants/${tenantId}/workflows/${id}`),
  updateWorkflow: (tenantId: string, id: string, body: any) => request(`/tenants/${tenantId}/workflows/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteWorkflow: (tenantId: string, id: string) => request(`/tenants/${tenantId}/workflows/${id}`, { method: 'DELETE' }),
  startWorkflowExecution: (tenantId: string, id: string, body: any) => request(`/tenants/${tenantId}/workflows/${id}/execute`, { method: 'POST', body: JSON.stringify(body) }),
  getWorkflowExecution: (tenantId: string, execId: string) => request(`/tenants/${tenantId}/workflows/executions/${execId}`),
  resumeWorkflowExecution: (tenantId: string, execId: string, body: any) => request(`/tenants/${tenantId}/workflows/executions/${execId}/resume`, { method: 'POST', body: JSON.stringify(body) }),
  dryRunWorkflowStep: (tenantId: string, body: { step: any; context?: any }) => request(`/tenants/${tenantId}/workflows/dry-run-step`, { method: 'POST', body: JSON.stringify(body) }),
  generateWorkflowFromPrompt: (tenantId: string, prompt: string) => request(`/tenants/${tenantId}/workflows/generate`, { method: 'POST', body: JSON.stringify({ prompt }) }),
  generateAgentFromPrompt: (tenantId: string, prompt: string) => request(`/tenants/${tenantId}/agents/generate`, { method: 'POST', body: JSON.stringify({ prompt }) }),
  generateSkill: (tenantId: string, body: { prompt: string; skillType: 'nl' | 'api' | 'code'; language?: 'javascript' | 'python' }) => request(`/tenants/${tenantId}/agents/generate-skill`, { method: 'POST', body: JSON.stringify(body) }),
  saveSystemLLMConfig: (tenantId: string, body: { systemProvider?: string | null; systemModel?: string | null }) => request(`/tenants/${tenantId}/settings/llm`, { method: 'PUT', body: JSON.stringify(body) }),

  // AI Builder Chatbot
  builderChat: (tenantId: string, body: { message: string; history?: Array<{ role: string; content: string }> }) =>
    request(`/tenants/${tenantId}/builder/chat`, { method: 'POST', body: JSON.stringify(body) }),
  builderContext: (tenantId: string) =>
    request(`/tenants/${tenantId}/builder/context`),
  builderQuickAgent: (tenantId: string, prompt: string) =>
    request(`/tenants/${tenantId}/builder/quick-agent`, { method: 'POST', body: JSON.stringify({ prompt }) }),
  builderQuickWorkflow: (tenantId: string, prompt: string) =>
    request(`/tenants/${tenantId}/builder/quick-workflow`, { method: 'POST', body: JSON.stringify({ prompt }) }),

  // Approvals (Human-in-the-Loop)
  listApprovals: (tenantId: string, status?: string) => request(`/tenants/${tenantId}/approvals${status ? `?status=${status}` : ''}`),
  decideApproval: (tenantId: string, approvalId: string, body: any) => request(`/tenants/${tenantId}/approvals/${approvalId}/decide`, { method: 'POST', body: JSON.stringify(body) }),

  // Audit Log
  listAuditLog: (tenantId: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return request(`/tenants/${tenantId}/audit${qs}`)
  },

  // Connectors / Tool Connections
  listConnectors: (tenantId: string) => request(`/tenants/${tenantId}/connectors`),
  createConnector: (tenantId: string, body: any) => request(`/tenants/${tenantId}/connectors`, { method: 'POST', body: JSON.stringify(body) }),
  updateConnector: (tenantId: string, connectorId: string, body: any) => request(`/tenants/${tenantId}/connectors/${connectorId}`, { method: 'PUT', body: JSON.stringify(body) }),
  testConnector: (tenantId: string, connectorId: string) => request(`/tenants/${tenantId}/connectors/${connectorId}/test`, { method: 'POST' }),
  deleteConnector: (tenantId: string, connectorId: string) => request(`/tenants/${tenantId}/connectors/${connectorId}`, { method: 'DELETE' }),
  toggleConnector: (tenantId: string, connectorId: string) => request(`/tenants/${tenantId}/connectors/${connectorId}/toggle`, { method: 'PUT' }),
  toggleBuiltinTool: (tenantId: string, toolName: string) => request(`/tenants/${tenantId}/tools/${encodeURIComponent(toolName)}/toggle`, { method: 'PUT' }),
  getBuiltinToolOverrides: (tenantId: string) => request(`/tenants/${tenantId}/tools/overrides`),
  initiateOAuth: (tenantId: string, body: { provider: string, service?: string, connectorId?: string }) => 
    request(`/tenants/${tenantId}/connectors/oauth/initiate`, { method: 'POST', body: JSON.stringify(body) }),

  // Analytics
  getAnalytics: (tenantId: string, params?: { days?: number }) => {
    const qs = params?.days ? `?days=${params.days}` : ''
    return request(`/tenants/${tenantId}/analytics${qs}`)
  },

  // Ambient Triggers
  listTriggers: (tenantId: string) => request(`/tenants/${tenantId}/triggers`),
  createTrigger: (tenantId: string, body: any) => request(`/tenants/${tenantId}/triggers`, { method: 'POST', body: JSON.stringify(body) }),
  updateTrigger: (tenantId: string, id: string, body: any) => request(`/tenants/${tenantId}/triggers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTrigger: (tenantId: string, id: string) => request(`/tenants/${tenantId}/triggers/${id}`, { method: 'DELETE' }),

  // A2A Agent Cards
  getAgentCard: (tenantId: string, agentId: string) => request(`/a2a/tenants/${tenantId}/agents/${agentId}`),
  a2aSubmitTask: (tenantId: string, agentId: string, body: any) => request(`/a2a/tenants/${tenantId}/agents/${agentId}/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  a2aPollTask: (tenantId: string, agentId: string, taskId: string) => request(`/a2a/tenants/${tenantId}/agents/${agentId}/tasks/${taskId}`),

  // System Administration
  getAdminTenants: () => request('/admin/tenants'),
  updateAdminTenant: (tenantId: string, body: { plan?: string, status?: string }) => 
    request(`/admin/tenants/${tenantId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  getAdminSystemStatus: () => request('/admin/system-status'),

  // Duplicate endpoints
  duplicateAgent: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}/duplicate`, { method: 'POST' }),

  // Agent Tool Scopes
  listScopes: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}/scopes`),
  addScope: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/scopes`, { method: 'POST', body: JSON.stringify(body) }),
  updateScope: (tenantId: string, agentId: string, scopeId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/scopes/${scopeId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  removeScope: (tenantId: string, agentId: string, scopeId: string) => request(`/tenants/${tenantId}/agents/${agentId}/scopes/${scopeId}`, { method: 'DELETE' }),
  setScopes: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/scopes`, { method: 'PUT', body: JSON.stringify(body) }),
  getScopePresets: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}/scopes/presets`),

  duplicateWorkflow: (tenantId: string, id: string) => request(`/tenants/${tenantId}/workflows/${id}/duplicate`, { method: 'POST' }),
  duplicateTrigger: (tenantId: string, id: string) => request(`/tenants/${tenantId}/triggers/${id}/duplicate`, { method: 'POST' }),

  // Chat
  listChatConversations: (tenantId: string) => request(`/tenants/${tenantId}/chat/conversations`),
  createChatConversation: (tenantId: string, body: { title?: string; model: string; provider: string }) =>
    request(`/tenants/${tenantId}/chat/conversations`, { method: 'POST', body: JSON.stringify(body) }),
  getChatConversation: (tenantId: string, conversationId: string) =>
    request(`/tenants/${tenantId}/chat/conversations/${conversationId}`),
  deleteChatConversation: (tenantId: string, conversationId: string) =>
    request(`/tenants/${tenantId}/chat/conversations/${conversationId}`, { method: 'DELETE' }),
  updateChatConversation: (tenantId: string, conversationId: string, body: { title: string }) =>
    request(`/tenants/${tenantId}/chat/conversations/${conversationId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  getChatMessages: (tenantId: string, conversationId: string) =>
    request(`/tenants/${tenantId}/chat/conversations/${conversationId}/messages`),
  sendChatMessage: (tenantId: string, conversationId: string, body: { content: string; knowledgeBaseIds?: string[]; graphIds?: string[] }) =>
    request(`/tenants/${tenantId}/chat/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify(body) }),

  // MCP Servers
  listMcpServers: (tenantId: string) => request(`/tenants/${tenantId}/mcp/servers`),
  addMcpServer: (tenantId: string, body: { name: string; url: string; authToken?: string }) =>
    request(`/tenants/${tenantId}/mcp/servers`, { method: 'POST', body: JSON.stringify(body) }),
  removeMcpServer: (tenantId: string, id: string) =>
    request(`/tenants/${tenantId}/mcp/servers/${id}`, { method: 'DELETE' }),
  listMcpTools: (tenantId: string, id: string) => request(`/tenants/${tenantId}/mcp/servers/${id}/tools`),

  // Feedback
  submitFeedback: (tenantId: string, body: { approvalId?: string; agentId?: string; qualityRating: number; feedbackText?: string; feedbackTags?: string[]; decision?: string }) =>
    request(`/tenants/${tenantId}/feedback`, { method: 'POST', body: JSON.stringify(body) }),
  listFeedback: (tenantId: string, agentId?: string) =>
    request(`/tenants/${tenantId}/feedback${agentId ? `?agentId=${agentId}` : ''}`),

  // Profile + password reset
  getProfile: () => request('/profile'),
  updateProfile: (body: { name?: string }) => request('/profile', { method: 'PATCH', body: JSON.stringify(body) }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request('/profile/change-password', { method: 'POST', body: JSON.stringify(body) }),
  forgotPassword: (body: { email: string }) =>
    request('/auth/forgot-password', { method: 'POST', body: JSON.stringify(body) }),
  resetPassword: (body: { token: string; newPassword: string }) =>
    request('/auth/reset-password', { method: 'POST', body: JSON.stringify(body) }),

  // Custom Models
  activateCustomModel: (tenantId: string, modelId: string) =>
    request(`/tenants/${tenantId}/custom-models/${modelId}/activate`, { method: 'POST' }),
  deleteCustomModel: (tenantId: string, modelId: string) =>
    request(`/tenants/${tenantId}/custom-models/${modelId}`, { method: 'DELETE' }),
  pushToOllama: (tenantId: string, modelId: string) =>
    request(`/tenants/${tenantId}/custom-models/${modelId}/push-to-ollama`, { method: 'POST', body: '{}' }),
}
