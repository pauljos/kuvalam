'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'

export default function AuditPage() {
  const { tenantId, toast } = useApp()
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({
    eventType: '',
    actorType: '',
    resourceType: '',
    search: '',
    dateFrom: '',
    dateTo: '',
  })

  useEffect(() => {
    if (tenantId) loadLogs(tenantId, filters)
  }, [tenantId, filters])

  async function loadLogs(tid: string, currentFilters: typeof filters) {
    setLoading(true)
    try {
      // Build query params
      const params: Record<string, string> = {}
      if (currentFilters.eventType) params.eventType = currentFilters.eventType
      if (currentFilters.actorType) params.actorType = currentFilters.actorType
      if (currentFilters.resourceType) params.resourceType = currentFilters.resourceType
      if (currentFilters.search) params.search = currentFilters.search
      if (currentFilters.dateFrom) params.dateFrom = currentFilters.dateFrom
      if (currentFilters.dateTo) params.dateTo = currentFilters.dateTo

      const res = await api.listAuditLog(tid, params)
      setLogs(res?.logs || [])
    } catch (err) {
      console.error('Failed to load audit logs:', err)
      toast('error', 'Failed to load audit logs', (err as any)?.message || '')
      setLogs([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-sub">Immutable record of every action taken by users, agents, and the system</p>
        </div>
        <button className="btn btn-secondary" onClick={() => tenantId && loadLogs(tenantId, filters)}>
          ↻ Refresh
        </button>
      </div>

      <div className="page-body">
        {/* Filters Bar */}
        <div className="card" style={{ padding: 16, marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>SEARCH</label>
            <input
              className="input"
              type="text"
              placeholder="Search event, actor, resource..."
              value={filters.search}
              onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
              style={{ padding: '8px 12px', fontSize: 13 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>FROM</label>
            <input
              className="input"
              type="date"
              value={filters.dateFrom}
              onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
              style={{ padding: '8px 12px', fontSize: 13 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>TO</label>
            <input
              className="input"
              type="date"
              value={filters.dateTo}
              onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
              style={{ padding: '8px 12px', fontSize: 13 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>ACTOR TYPE</label>
            <select
              className="select"
              value={filters.actorType}
              onChange={e => setFilters(f => ({ ...f, actorType: e.target.value }))}
              style={{ padding: '8px 12px', fontSize: 13 }}
            >
              <option value="">All Actors</option>
              <option value="USER">User</option>
              <option value="AGENT">Agent</option>
              <option value="SYSTEM">System</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>RESOURCE TYPE</label>
            <select
              className="select"
              value={filters.resourceType}
              onChange={e => setFilters(f => ({ ...f, resourceType: e.target.value }))}
              style={{ padding: '8px 12px', fontSize: 13 }}
            >
              <option value="">All Resources</option>
              <option value="Workflow">Workflow</option>
              <option value="WorkflowExecution">WorkflowExecution</option>
              <option value="Agent">Agent</option>
              <option value="AgentTask">AgentTask</option>
              <option value="ToolConnection">ToolConnection</option>
              <option value="ApprovalRequest">ApprovalRequest</option>
              <option value="KnowledgeBase">KnowledgeBase</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>EVENT TYPE</label>
            <input
              className="input"
              type="text"
              placeholder="e.g. workflow.created"
              value={filters.eventType}
              onChange={e => setFilters(f => ({ ...f, eventType: e.target.value }))}
              style={{ padding: '8px 12px', fontSize: 13 }}
            />
          </div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton" style={{ height: 50, borderRadius: 6 }} />)}
            </div>
          ) : logs.length === 0 ? (
            <div className="empty-state" style={{ padding: 40 }}>
              <span style={{ fontSize: 32 }}>📋</span>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginTop: 12 }}>No logs recorded yet</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Logs will populate here as agents perform tasks and configurations change.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Event Type</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Resource</th>
                    <th>Details</th>
                    <th>Payload</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log: any) => {
                    const meta = log.metadata || {}
                    // Build a human-readable detail line from metadata
                    let detail = ''
                    if (log.event_type === 'agent.tool_executed') {
                      detail = meta.success ? '✅ ' : '❌ '
                      detail += log.action
                      if (meta.input) {
                        try {
                          const parsed = typeof meta.input === 'string' ? JSON.parse(meta.input) : meta.input
                          const keys = Object.keys(parsed).filter(k => k !== 'df' && k !== 'data')
                          if (keys.length) detail += ` (${keys.join(', ')})`
                        } catch { /* ignore */ }
                      }
                      if (meta.error) detail += ` — ${meta.error}`
                    } else if (log.event_type === 'agent.task_completed') {
                      const st = log.after_state || {}
                      detail = `${st.status || 'done'} · ${st.tokensUsed || 0} tokens · ${st.actionsCount || 0} actions`
                    } else if (log.event_type === 'workflow.step_completed') {
                      detail = `Step: ${meta.stepId || '?'} (${meta.stepType || '?'}) · ${meta.durationMs ? `${(meta.durationMs/1000).toFixed(1)}s` : ''}`
                    } else if (log.event_type === 'workflow.execution_completed') {
                      detail = `${meta.stepCount || 0} steps · ${meta.durationMs ? `${(meta.durationMs/1000).toFixed(1)}s` : ''}`
                    } else if (log.event_type === 'trigger.fired') {
                      detail = meta.workflowName || meta.triggerType || ''
                    } else if (meta.goal) {
                      detail = meta.goal
                    }
                    return (
                    <tr key={log.id}>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td>
                        <span style={{
                          fontSize: 11, padding: '2px 8px', background: 'var(--green-pale)', color: 'var(--green-dark)', borderRadius: 4, fontWeight: 600
                        }}>
                          {log.event_type}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, fontWeight: 600 }}>{log.action || '—'}</td>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{log.actor_type}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>ID: {log.actor_id?.substring(0, 8)}</div>
                      </td>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{log.resource_type || '—'}</div>
                        {log.resource_id && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>ID: {log.resource_id.substring(0, 8)}</div>}
                      </td>
                      <td style={{ fontSize: 11, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={detail}>
                        {detail || '—'}
                      </td>
                      <td>
                        <pre style={{
                          fontSize: 11, background: 'var(--bg)', padding: '6px 10px', borderRadius: 4,
                          maxHeight: 100, overflowY: 'auto', border: '1px solid var(--border)', maxWidth: 300,
                          whiteSpace: 'pre-wrap', wordBreak: 'break-all'
                        }}>
                          {JSON.stringify(Object.keys(meta).length ? meta : (log.after_state || log.before_state || {}), null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
