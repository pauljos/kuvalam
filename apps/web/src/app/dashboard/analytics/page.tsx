'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'

function MetricCard({ icon, label, value, sub, color = 'var(--green)' }: any) {
  return (
    <div className="stat-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ fontSize: 20 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 32, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

function MiniBar({ value, max, color = 'var(--green)' }: any) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div style={{ height: 6, background: 'var(--border)', borderRadius: 99, overflow: 'hidden', flex: 1 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 99, transition: 'width 0.5s ease' }} />
    </div>
  )
}

function DailyChart({ data }: { data: any[] }) {
  if (!data?.length) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
        No task activity in the last 14 days
      </div>
    )
  }

  const maxTasks = Math.max(...data.map(d => parseInt(d.tasks) || 0), 1)

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 80, padding: '0 4px' }}>
      {data.map((d, i) => {
        const count = parseInt(d.tasks) || 0
        const completed = parseInt(d.completed) || 0
        const height = Math.max((count / maxTasks) * 72, 4)
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={`${d.day}: ${count} tasks, ${completed} completed`}>
            <div style={{ width: '100%', height, background: 'var(--green)', borderRadius: '3px 3px 0 0', opacity: 0.85, cursor: 'default' }} />
            <div style={{ fontSize: 9, color: 'var(--text-muted)', transform: 'rotate(-45deg)', transformOrigin: 'center', whiteSpace: 'nowrap', marginTop: 4 }}>
              {new Date(d.day).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function AnalyticsPage() {
  const { tenantId } = useApp()
  const [analytics, setAnalytics] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [refreshed, setRefreshed] = useState<Date | null>(null)

  useEffect(() => {
    if (tenantId) loadAnalytics(tenantId)
  }, [tenantId])

  async function loadAnalytics(tid: string) {
    setLoading(true)
    try {
      const data = await api.getAnalytics(tid)
      setAnalytics(data)
      setRefreshed(new Date())
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="animate-in">
        <div className="page-header">
          <div><h1 className="page-title">Analytics</h1></div>
        </div>
        <div className="page-body">
          <div className="stats-grid" style={{ marginBottom: 24 }}>
            {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 96, borderRadius: 10 }} />)}
          </div>
          <div className="skeleton" style={{ height: 240, borderRadius: 10 }} />
        </div>
      </div>
    )
  }

  if (!analytics) {
    return (
      <div className="animate-in">
        <div className="page-header">
          <div><h1 className="page-title">Analytics</h1></div>
        </div>
        <div className="page-body">
          <div className="card empty-state">
            <span className="empty-icon">📊</span>
            <h2 className="empty-title">No analytics data yet</h2>
            <p className="empty-desc">Start creating agents and dispatching tasks to see performance metrics here.</p>
          </div>
        </div>
      </div>
    )
  }

  const { agents, tasks, workflows, knowledge, approvals, recentActivity, tasksByDay, topAgents, llmCost } = analytics

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-sub">30-day operational metrics across your agents</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {refreshed && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Updated {refreshed.toLocaleTimeString()}
            </span>
          )}
          <button className="btn btn-secondary" onClick={() => loadAnalytics(tenantId)}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="page-body">

        {/* KPI Row */}
        <div className="stats-grid" style={{ marginBottom: 28 }}>
          <MetricCard icon="⚡" label="Active Agents" value={agents.active} sub={`${agents.total} total configured`} />
          <MetricCard icon="✓" label="Task Success Rate" value={`${tasks.successRate}%`} sub={`${tasks.completed} of ${tasks.total} tasks completed`} color={tasks.successRate >= 80 ? 'var(--green)' : tasks.successRate >= 60 ? '#d97706' : '#dc2626'} />
          <MetricCard icon="⟳" label="Workflow Runs" value={workflows.total} sub={`${workflows.completed} completed · ${workflows.pendingApproval} awaiting approval`} />
          <MetricCard icon="📚" label="Knowledge Docs" value={knowledge.documents} sub={`${knowledge.knowledgeBases} knowledge base${knowledge.knowledgeBases !== 1 ? 's' : ''}`} />
        </div>

        {/* Two-column section */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>

          {/* Task Activity Chart */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 14, fontWeight: 700 }}>Task Volume — Last 14 Days</h2>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--green)' }}>{tasks.total} total</span>
            </div>
            <DailyChart data={tasksByDay} />
          </div>

          {/* Approval Summary */}
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 20 }}>Human-in-the-Loop Summary</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[
                { label: 'Pending Review', value: approvals.pending, color: '#d97706' },
                { label: 'Approved', value: approvals.approved, color: 'var(--green)' },
                { label: 'Rejected', value: approvals.rejected, color: '#dc2626' },
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 120, fontSize: 13, color: 'var(--text-sub)' }}>{item.label}</div>
                  <MiniBar value={item.value} max={approvals.total || 1} color={item.color} />
                  <div style={{ fontSize: 14, fontWeight: 700, color: item.color, minWidth: 36, textAlign: 'right' }}>{item.value}</div>
                </div>
              ))}
              <div style={{ marginTop: 8, paddingTop: 14, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
                {approvals.total} total approval requests since launch
              </div>
            </div>
          </div>
        </div>

        {/* Top Agents Table */}
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 20 }}>Top Agents by Task Output (30 days)</h2>
          {topAgents.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
              No agent task data yet. Dispatch tasks to agents to see performance here.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Type</th>
                  <th>Tasks Run</th>
                  <th>Completed</th>
                  <th>Failed</th>
                  <th>Success Rate</th>
                </tr>
              </thead>
              <tbody>
                {topAgents.map((agent: any) => (
                  <tr key={agent.id}>
                    <td style={{ fontWeight: 700 }}>{agent.name}</td>
                    <td>
                      <span style={{ fontSize: 11, padding: '2px 8px', background: 'var(--green-pale)', color: 'var(--green-dark)', borderRadius: 4, fontWeight: 600 }}>
                        {agent.archetype}
                      </span>
                    </td>
                    <td>{agent.task_count}</td>
                    <td style={{ color: 'var(--green)' }}>{agent.completed}</td>
                    <td style={{ color: agent.failed > 0 ? '#dc2626' : 'var(--text-muted)' }}>{agent.failed}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <MiniBar value={agent.successRate} max={100} color={agent.successRate >= 80 ? 'var(--green)' : '#d97706'} />
                        <span style={{ fontSize: 12, fontWeight: 700, minWidth: 36, color: agent.successRate >= 80 ? 'var(--green)' : '#d97706' }}>
                          {agent.successRate}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* LLM Cost Estimate */}
        {llmCost && (
          <div className="card" style={{ padding: 24, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 14, fontWeight: 700 }}>LLM Token Usage &amp; Cost Estimate (30 days)</h2>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Estimated only — based on public pricing</span>
            </div>
            <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total Tokens</div>
                <div style={{ fontSize: 26, fontWeight: 900, color: 'var(--text)' }}>{llmCost.totalTokens.toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Est. Cost</div>
                <div style={{ fontSize: 26, fontWeight: 900, color: '#d97706' }}>${llmCost.estimatedCostUsd.toFixed(4)}</div>
              </div>
            </div>
            {llmCost.byModel.length > 0 && (
              <table className="table" style={{ fontSize: 12 }}>
                <thead>
                  <tr><th>Model</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>Total</th><th>Est. Cost</th></tr>
                </thead>
                <tbody>
                  {llmCost.byModel.map((row: any) => (
                    <tr key={row.model}>
                      <td style={{ fontWeight: 600 }}>{row.model}</td>
                      <td>{row.promptTokens.toLocaleString()}</td>
                      <td>{row.completionTokens.toLocaleString()}</td>
                      <td>{row.totalTokens.toLocaleString()}</td>
                      <td style={{ color: '#d97706', fontWeight: 700 }}>${row.estimatedCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Recent Activity Feed */}
        <div className="card" style={{ padding: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 20 }}>Recent Activity</h2>
          {recentActivity.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No recent activity to display.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {recentActivity.map((event: any, i: number) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 0', borderBottom: i < recentActivity.length - 1 ? '1px solid var(--border)' : 'none'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 8, background: 'var(--green-pale)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14
                    }}>
                      {event.actor_type === 'USER' ? '👤' : event.actor_type === 'AGENT' ? '⚡' : '⚙️'}
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{event.action?.replace(/_/g, ' ')}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {event.resource_type} · {event.actor_type.toLowerCase()}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
                    {new Date(event.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
