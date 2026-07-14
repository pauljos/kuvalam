'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'

export default function AuditPage() {
  const { tenantId } = useApp()
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({
    eventType: '',
    actorType: '',
    resourceType: ''
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

      const res = await api.listAuditLog(tid, params)
      setLogs(res?.logs || [])
    } catch (err) {
      console.error('Failed to load audit logs:', err)
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
        <div className="card" style={{ padding: 16, marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>ACTOR TYPE</label>
            <select
              className="select"
              value={filters.actorType}
              onChange={e => setFilters(f => ({ ...f, actorType: e.target.value }))}
            >
              <option value="">All Actors</option>
              <option value="USER">User</option>
              <option value="AGENT">Agent</option>
              <option value="SYSTEM">System</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>RESOURCE TYPE</label>
            <select
              className="select"
              value={filters.resourceType}
              onChange={e => setFilters(f => ({ ...f, resourceType: e.target.value }))}
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
                    <th>Action / Event</th>
                    <th>Actor</th>
                    <th>Resource</th>
                    <th>Payload Details</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log: any) => (
                    <tr key={log.id}>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td style={{ fontWeight: 700 }}>
                        <span style={{
                          fontSize: 11, padding: '2px 8px', background: 'var(--green-pale)', color: 'var(--green-dark)', borderRadius: 4, fontWeight: 600, textTransform: 'uppercase'
                        }}>
                          {log.action || log.event_type}
                        </span>
                      </td>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{log.actor_type}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>ID: {log.actor_id?.substring(0, 8)}</div>
                      </td>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{log.resource_type || '—'}</div>
                        {log.resource_id && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>ID: {log.resource_id.substring(0, 8)}</div>}
                      </td>
                      <td>
                        <pre style={{
                          fontSize: 11, background: 'var(--bg)', padding: '6px 10px', borderRadius: 4,
                          maxHeight: 100, overflowY: 'auto', border: '1px solid var(--border)', maxWidth: 400,
                          whiteSpace: 'pre-wrap', wordBreak: 'break-all'
                        }}>
                          {JSON.stringify(log.after_state || log.before_state || {}, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
