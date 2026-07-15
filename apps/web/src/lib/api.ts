// src/lib/api.ts — API client
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
const API = API_BASE.endsWith('/api/v1') ? API_BASE : `${API_BASE}/api/v1`

// Re-export shared API types so consumers can `import { Agent } from '@/lib/api'`
export * from './api-types'

// Coalesce concurrent refresh calls so we only hit /auth/refresh once even
// when a page fires ten API calls in parallel and they all 401 together.
let refreshInFlight: Promise<boolean> | null = null

async function tryRefreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      // Server reads the httpOnly kuvalam_refresh cookie — no body needed.
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
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

  const res = await fetch(`${API}${path}`, {
    ...options,
    headers,
    credentials: 'include', // sends the httpOnly kuvalam_token cookie automatically
  })

  // On expired access token, try to silently mint a new one via the refresh
  // cookie, then replay the original request exactly once. This makes the
  // 15-minute JWT invisible to users \u2014 sessions feel like they last 30 days.
  if (res.status === 401 && !_isRetry && !path.startsWith('/auth/')) {
    const refreshed = await tryRefreshSession()
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

  // Agents
  createAgent: (tenantId: string, body: any) => request(`/tenants/${tenantId}/agents`, { method: 'POST', body: JSON.stringify(body) }),
  listAgents: (tenantId: string) => request(`/tenants/${tenantId}/agents`),
  getAgent: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}`),
  updateAgent: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  activateAgent: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}/activate`, { method: 'POST' }),
  addSkill: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/skills`, { method: 'POST', body: JSON.stringify(body) }),
  testSkill: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/test-skill`, { method: 'POST', body: JSON.stringify(body) }),
  addRule: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/rules`, { method: 'POST', body: JSON.stringify(body) }),
  dispatchTask: (tenantId: string, agentId: string, body: any) => request(`/tenants/${tenantId}/agents/${agentId}/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  listTasks: (tenantId: string, agentId: string) => request(`/tenants/${tenantId}/agents/${agentId}/tasks`),
  getTask: (tenantId: string, agentId: string, taskId: string) => request(`/tenants/${tenantId}/agents/${agentId}/tasks/${taskId}`),
  linkKB: (tenantId: string, agentId: string, kbId: string) => request(`/tenants/${tenantId}/agents/${agentId}/knowledge-bases/${kbId}`, { method: 'POST' }),

  // Knowledge
  createKB: (tenantId: string, body: any) => request(`/tenants/${tenantId}/knowledge-bases`, { method: 'POST', body: JSON.stringify(body) }),
  listKBs: (tenantId: string) => request(`/tenants/${tenantId}/knowledge-bases`),
  getKB: (tenantId: string, kbId: string) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}`),
  addDocument: (tenantId: string, kbId: string, body: any) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/documents`, { method: 'POST', body: JSON.stringify(body) }),
  listDocuments: (tenantId: string, kbId: string) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/documents`),
  searchKB: (tenantId: string, kbId: string, body: any) => request(`/tenants/${tenantId}/knowledge-bases/${kbId}/search`, { method: 'POST', body: JSON.stringify(body) }),

  // Settings
  getSettings: (tenantId: string) => request(`/tenants/${tenantId}/settings`),
  saveLLMConfig: (tenantId: string, body: any) => request(`/tenants/${tenantId}/settings/llm`, { method: 'PUT', body: JSON.stringify(body) }),
  removeLLMProvider: (tenantId: string, provider: string) => request(`/tenants/${tenantId}/settings/llm/${provider}`, { method: 'DELETE' }),
  testLLMProvider: (tenantId: string, body: any) => request(`/tenants/${tenantId}/settings/llm/test`, { method: 'POST', body: JSON.stringify(body) }),
  saveGeneralSettings: (tenantId: string, body: any) => request(`/tenants/${tenantId}/settings/general`, { method: 'PUT', body: JSON.stringify(body) }),

  // Workflows
  listWorkflows: (tenantId: string) => request(`/tenants/${tenantId}/workflows`),
  listWorkflowExecutions: (tenantId: string) => request(`/tenants/${tenantId}/workflows/executions`),
  createWorkflow: (tenantId: string, body: any) => request(`/tenants/${tenantId}/workflows`, { method: 'POST', body: JSON.stringify(body) }),
  getWorkflow: (tenantId: string, id: string) => request(`/tenants/${tenantId}/workflows/${id}`),
  updateWorkflow: (tenantId: string, id: string, body: any) => request(`/tenants/${tenantId}/workflows/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  startWorkflowExecution: (tenantId: string, id: string, body: any) => request(`/tenants/${tenantId}/workflows/${id}/execute`, { method: 'POST', body: JSON.stringify(body) }),
  getWorkflowExecution: (tenantId: string, execId: string) => request(`/tenants/${tenantId}/workflows/executions/${execId}`),
  resumeWorkflowExecution: (tenantId: string, execId: string, body: any) => request(`/tenants/${tenantId}/workflows/executions/${execId}/resume`, { method: 'POST', body: JSON.stringify(body) }),
  dryRunWorkflowStep: (tenantId: string, body: { step: any; context?: any }) => request(`/tenants/${tenantId}/workflows/dry-run-step`, { method: 'POST', body: JSON.stringify(body) }),

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
  testConnector: (tenantId: string, connectorId: string) => request(`/tenants/${tenantId}/connectors/${connectorId}/test`, { method: 'POST' }),
  deleteConnector: (tenantId: string, connectorId: string) => request(`/tenants/${tenantId}/connectors/${connectorId}`, { method: 'DELETE' }),
  initiateOAuth: (tenantId: string, body: { provider: string, service?: string, connectorId?: string }) => 
    request(`/tenants/${tenantId}/connectors/oauth/initiate`, { method: 'POST', body: JSON.stringify(body) }),

  // Analytics
  getAnalytics: (tenantId: string) => request(`/tenants/${tenantId}/analytics`),

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
  duplicateWorkflow: (tenantId: string, id: string) => request(`/tenants/${tenantId}/workflows/${id}/duplicate`, { method: 'POST' }),
  duplicateTrigger: (tenantId: string, id: string) => request(`/tenants/${tenantId}/triggers/${id}/duplicate`, { method: 'POST' }),

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
}
