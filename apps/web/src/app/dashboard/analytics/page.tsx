'use client'
import { useEffect, useMemo, useState } from 'react'
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

const DATE_PRESETS = [
  { label: '7 days', value: 7 },
  { label: '14 days', value: 14 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
]

export default function AnalyticsPage() {
  const { tenantId, toast } = useApp()
  const [analytics, setAnalytics] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [refreshed, setRefreshed] = useState<Date | null>(null)
  const [dateRange, setDateRange] = useState(30)
  const [tab, setTab] = useState<'overview' | 'models'>('overview')

  useEffect(() => {
    if (tenantId) loadAnalytics(tenantId)
    else setLoading(false)
  }, [tenantId])

  async function loadAnalytics(tid: string, days?: number) {
    const range = days ?? dateRange
    setLoading(true)
    try {
      const data = await api.getAnalytics(tid, { days: range })
      setAnalytics(data)
      setRefreshed(new Date())
    } catch (err) {
      console.error(err)
      toast('error', 'Failed to load analytics', (err as any)?.message || '')
    } finally {
      setLoading(false)
    }
  }

  function changeRange(days: number) {
    setDateRange(days)
    if (tenantId) loadAnalytics(tenantId, days)
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
            <h2 className="empty-title">{tenantId ? 'No analytics data yet' : 'Select an organization'}</h2>
            <p className="empty-desc">{tenantId ? 'Start creating agents and dispatching tasks to see performance metrics here.' : 'Sign in with an organization account or select a tenant to view analytics.'}</p>
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
          <p className="page-sub">Operational metrics across your agents</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg)', borderRadius: 8, padding: 3, border: '1px solid var(--border)' }}>
            {DATE_PRESETS.map(p => (
              <button
                key={p.value}
                onClick={() => changeRange(p.value)}
                style={{
                  padding: '5px 12px', fontSize: 12, fontWeight: 700, border: 'none', borderRadius: 6,
                  background: dateRange === p.value ? 'var(--green)' : 'transparent',
                  color: dateRange === p.value ? '#fff' : 'var(--text-muted)',
                  cursor: 'pointer', transition: 'all 0.15s',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          {refreshed && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Updated {refreshed.toLocaleTimeString()}
            </span>
          )}
          <button className="btn btn-secondary" onClick={() => tenantId && loadAnalytics(tenantId)}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, padding: '0 24px', marginBottom: 20 }}>
        {([
          { key: 'overview', label: '📊 Overview' },
          { key: 'models', label: '🧠 Model Performance' },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 16px', fontSize: 13, fontWeight: 700, border: 'none', borderRadius: 8,
              background: tab === t.key ? 'var(--green)' : 'transparent',
              color: tab === t.key ? '#fff' : 'var(--text-muted)',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="page-body">

        {tab === 'overview' && (<>
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
                      {event.actor?.type === 'USER' ? '👤' : event.actor?.type === 'AGENT' ? '⚡' : '⚙️'}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
                        {event.summary || event.action?.replace(/_/g, ' ')}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {event.actor?.name ?? event.actor?.id} · {event.eventType?.replace(/_/g, ' ').replace('agent.', '').replace('workflow.', '')}
                        {event.durationMs ? ` · ${event.durationMs > 1000 ? `${(event.durationMs / 1000).toFixed(1)}s` : `${event.durationMs}ms`}` : ''}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
                    {event.timestamp ? new Date(event.timestamp).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        </>)}

        {tab === 'models' && <ModelPerformanceView data={analytics.modelPerformance} />}

      </div>
    </div>
  )
}

// ── Model Performance tab ────────────────────────────────────────────────
function fmtDuration(ms: number) {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function scoreColor(v: number) {
  if (v >= 80) return 'var(--green)'
  if (v >= 60) return '#d97706'
  return '#dc2626'
}

// ── Interactive Grouped Bar Chart ────────────────────────────────────────
const MODEL_COLORS = ['#6366f1','#f43f5e','#10b981','#f59e0b','#06b6d4','#ec4899','#84cc16','#14b8a6']
const BAR_COLORS = {
  success: '#22c55e',
  hallucination: '#8b5cf6',
  outputQuality: '#f59e0b',
  scopeAdherence: '#06b6d4',
  toolAccuracy: '#ec4899',
}
const BAR_LABELS: Record<string, string> = {
  success: 'Success %',
  hallucination: 'Hallucination',
  outputQuality: 'Output Quality',
  scopeAdherence: 'Scope Adherence',
  toolAccuracy: 'Tool Accuracy',
}

function InteractiveBarChart({ byModel, selectedModel, onSelect, agentModels }: {
  byModel: any[]
  selectedModel: string | null
  onSelect: (model: string | null) => void
  agentModels?: any[]
}) {
  // When agentModels provided, render per-LLM bars for that agent instead
  const data = agentModels && agentModels.length > 0 ? agentModels : byModel
  const useAgentView = !!(agentModels && agentModels.length > 0)

  const n = data.length
  const W = 800; const H = 280
  const M = { top: 20, right: 20, bottom: 44, left: 52 }
  const chartW = W - M.left - M.right
  const chartH = H - M.top - M.bottom
  const groupW = n > 0 ? chartW / n : chartW
  const barCount = 5
  const barPadding = 2
  const groupPadding = Math.max(groupW * 0.14, 4)
  const barW = Math.max((groupW - groupPadding * 2 - barPadding * (barCount - 1)) / barCount, 2)

  const yTicks = [0, 25, 50, 75, 100]

  const barDefs: { model: string; metric: string; value: number; x: number; y: number; h: number; color: string }[] = []
  data.forEach((m, gi) => {
    const gx = M.left + gi * groupW + groupPadding
    const metrics = [
      { key: 'success', value: m.successRate },
      { key: 'hallucination', value: m.hallucinationScore },
      { key: 'outputQuality', value: m.outputQuality ?? 80 },
      { key: 'scopeAdherence', value: m.scopeAdherence ?? 100 },
      { key: 'toolAccuracy', value: m.toolAccuracy ?? 80 },
    ]
    metrics.forEach((mt, bi) => {
      const bx = gx + bi * (barW + barPadding)
      const bh = Math.max((mt.value / 100) * chartH, 1)
      const by = M.top + chartH - bh
      barDefs.push({ model: m.model || m.agentName, metric: mt.key, value: mt.value, x: bx, y: by, h: bh, color: BAR_COLORS[mt.key as keyof typeof BAR_COLORS] })
    })
  })

  const handleClick = (model: string) => {
    onSelect(selectedModel === model ? null : model)
  }

  return (
    <div className="card" style={{ padding: 24, overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700 }}>📊 Model Metrics Comparison</h2>
        {selectedModel && (
          <button onClick={() => onSelect(null)} style={{
            fontSize: 11, fontWeight: 700, border: '1px solid var(--border)', borderRadius: 6,
            background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px 12px',
          }}>
            ✕ Clear selection
          </button>
        )}
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        {useAgentView ? 'Per-LLM quality metrics for the selected agent.' : 'Click a bar to drill into agent-level detail for that model.'}
      </p>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 18, marginBottom: 12 }}>
        {Object.entries(BAR_LABELS).map(([key, label]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 12, height: 12, borderRadius: 3, background: BAR_COLORS[key as keyof typeof BAR_COLORS] }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-sub)' }}>{label}</span>
          </div>
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 800, display: 'block' }}>
        {/* Grid lines + Y labels */}
        {yTicks.map(tick => {
          const y = M.top + chartH - (tick / 100) * chartH
          return (
            <g key={tick}>
              <line x1={M.left} y1={y} x2={W - M.right} y2={y} stroke="var(--border)" strokeWidth="1" />
              <text x={M.left - 8} y={y + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)" fontWeight={600}>
                {tick}
              </text>
            </g>
          )
        })}

        {/* Bars */}
        {barDefs.map((d, i) => {
          const isSelected = selectedModel === d.model
          const isDimmed = selectedModel !== null && !isSelected
          const opacity = isDimmed ? 0.25 : 1
          return (
            <g key={i} onClick={() => handleClick(d.model)} style={{ cursor: 'pointer' }}>
              <rect
                x={d.x} y={d.y} width={barW} height={d.h}
                fill={d.color} opacity={opacity} rx={2}
                style={{ transition: 'opacity 0.2s ease' }}
              />
              <title>{`${d.model} — ${BAR_LABELS[d.metric]}: ${d.value}/100`}</title>
              {/* Selected highlight ring */}
              {isSelected && (
                <rect x={d.x - 1} y={d.y - 1} width={barW + 2} height={d.h + 2}
                  fill="none" stroke="var(--text)" strokeWidth={2} rx={3} opacity={0.7} />
              )}
            </g>
          )
        })}

        {/* X-axis model labels */}
        {data.map((m, gi) => {
          const cx = M.left + gi * groupW + groupW / 2
          const raw = (useAgentView ? (m.model || m.agentName) : m.model) || 'unknown'
          const label = raw.length > 14 ? raw.slice(0, 13) + '…' : raw
          const keyColor = MODEL_COLORS[gi % MODEL_COLORS.length]
          return (
            <g key={gi}>
              <rect x={M.left + gi * groupW + (groupW - 12) / 2} y={H - 16} width={12} height={4} rx={2} fill={keyColor} />
              <text x={cx} y={H - 4} textAnchor="middle" fontSize={11} fill="var(--text-sub)" fontWeight={700}>
                {label}
                <title>{raw}</title>
              </text>
            </g>
          )
        })}

        {/* Y-axis label */}
        <text x={14} y={M.top + chartH / 2} textAnchor="middle" fontSize={10} fill="var(--text-muted)" fontWeight={600}
          transform={`rotate(-90, 14, ${M.top + chartH / 2})`}>
          Score
        </text>
      </svg>

      {/* Model key */}
      <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        {data.map((m, i) => {
          const raw = (useAgentView ? (m.model || m.agentName) : m.model) || 'unknown'
          const color = MODEL_COLORS[i % MODEL_COLORS.length]
          return (
            <span key={i} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, fontWeight: 600, color: 'var(--text-sub)',
              cursor: 'pointer', padding: '3px 8px', borderRadius: 4,
              background: selectedModel === raw ? 'var(--bg-hover)' : 'transparent',
              border: selectedModel === raw ? '1px solid var(--border)' : '1px solid transparent',
            }} onClick={() => handleClick(raw)}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
              {raw}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ── Agent Drill-Down Table ────────────────────────────────────────────────
function AgentDrillDown({ agents }: { agents: any[] }) {
  return (
    <div className="card" style={{ padding: 24 }}>
      <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>
        🤖 Agents Using This Model ({agents.length})
      </h2>
      {agents.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
          No agent data available for this model.
        </p>
      ) : (
        <table className="table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Archetype</th>
              <th>Tasks</th>
              <th>Success</th>
              <th>Output Quality</th>
              <th>Hallucination</th>
              <th>Scope</th>
              <th>Tool Acc</th>
              <th>Avg Speed</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a: any) => (
              <tr key={a.agentId + a.model}>
                <td style={{ fontWeight: 700 }}>{a.agentName}</td>
                <td>
                  <span style={{ fontSize: 11, padding: '2px 8px', background: 'var(--green-pale)', color: 'var(--green-dark)', borderRadius: 4, fontWeight: 600 }}>
                    {a.archetype}
                  </span>
                </td>
                <td>{a.taskCount}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MiniBar value={a.successRate} max={100} color={scoreColor(a.successRate)} />
                    <span style={{ fontWeight: 700, color: scoreColor(a.successRate), minWidth: 34 }}>{a.successRate}%</span>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MiniBar value={a.outputQuality ?? 80} max={100} color={scoreColor(a.outputQuality ?? 80)} />
                    <span style={{ fontWeight: 700, color: scoreColor(a.outputQuality ?? 80), minWidth: 34 }}>{a.outputQuality ?? 80}</span>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MiniBar value={a.hallucinationScore} max={100} color={scoreColor(a.hallucinationScore)} />
                    <span style={{ fontWeight: 700, color: scoreColor(a.hallucinationScore), minWidth: 34 }}>{a.hallucinationScore}</span>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MiniBar value={a.scopeAdherence ?? 100} max={100} color={scoreColor(a.scopeAdherence ?? 100)} />
                    <span style={{ fontWeight: 700, color: scoreColor(a.scopeAdherence ?? 100), minWidth: 34 }}>{a.scopeAdherence ?? 100}</span>
                  </div>
                </td>
                <td>
                  {a.toolAccuracy != null ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <MiniBar value={a.toolAccuracy} max={100} color={scoreColor(a.toolAccuracy)} />
                      <span style={{ fontWeight: 700, color: scoreColor(a.toolAccuracy), minWidth: 34 }}>{a.toolAccuracy}</span>
                    </div>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                  )}
                </td>
                <td>{fmtDuration(a.avgDurationMs)}</td>
                <td>{a.avgTokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ModelPerformanceView({ data }: { data: any }) {
  const byModel = data?.byModel || []
  const byAgent = data?.byAgent || []
  const latestByAgentModel = data?.latestByAgentModel || {}
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  if (byModel.length === 0) {
    return (
      <div className="card empty-state">
        <span className="empty-icon">🧠</span>
        <h2 className="empty-title">No model performance data yet</h2>
        <p className="empty-desc">Dispatch tasks to agents to see per-model speed, success, hallucination, and quality metrics here.</p>
      </div>
    )
  }

  // ── Latest execution per model for the selected agent ────────────────
  // Uses DISTINCT ON (agent, model, created_at DESC) from the API — shows
  // the MOST RECENT task's actual scores, not a blended historical average.
  const agentModelData = useMemo(() => {
    if (!selectedAgent) return null

    // Collect latest-execution entries for this agent
    const prefix = `${selectedAgent}::`
    const latestEntries = Object.entries(latestByAgentModel)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, val]: [string, any]) => ({
        model: key.slice(prefix.length),
        ...val,
      }))

    if (latestEntries.length > 0) {
      // Use the latest execution scores — each row is ONE task per model
      return latestEntries.map((e: any) => ({
        model: e.model,
        provider: e.provider || 'unknown',
        taskCount: 1,
        successRate: e.status === 'COMPLETED' ? 100 : 0,
        hallucinationScore: e.hallucinationScore,
        outputQuality: e.outputQuality,
        scopeAdherence: e.scopeAdherence,
        toolAccuracy: e.toolAccuracy,
        contextUsage: e.contextUsage,
        toolRelevance: e.toolRelevance,
        humanLikeness: e.humanLikeness,
        avgDurationMs: e.durationMs,
        avgTokens: e.tokens,
        avgActions: e.actionsCount,
        agentName: e.model,
        _latest: true,
      }))
    }

    // Fallback: no latest-execution data (all tasks failed, or pre-fix).
    // Average the historical byAgent rows for this agent instead.
    const rows = byAgent.filter((a: any) => a.agentId === selectedAgent)
    if (rows.length === 0) return null
    const agg: Record<string, any> = {}
    for (const r of rows) {
      const key = r.model
      if (!agg[key]) {
        agg[key] = {
          model: r.model,
          provider: r.provider,
          taskCount: 0,
          completed: 0,
          totalSuccessRate: 0,
          totalHallucinationScore: 0,
          totalOutputQuality: 0,
          totalScopeAdherence: 0,
          totalToolAccuracy: 0,
          toolAccuracyTaskCount: 0,
          totalContextUsage: 0,
          contextUsageTaskCount: 0,
          totalToolRelevance: 0,
          toolRelevanceTaskCount: 0,
          totalHumanLikeness: 0,
          humanLikenessTaskCount: 0,
          totalDurationMs: 0,
        }
      }
      const a = agg[key]
      a.taskCount += r.taskCount
      a.completed += r.completed
      a.totalSuccessRate += r.successRate * r.taskCount
      a.totalHallucinationScore += r.hallucinationScore * r.taskCount
      a.totalOutputQuality += (r.outputQuality ?? 80) * r.taskCount
      a.totalScopeAdherence += (r.scopeAdherence ?? 100) * r.taskCount
      if (r.toolAccuracy != null) {
        a.totalToolAccuracy += r.toolAccuracy * r.taskCount
        a.toolAccuracyTaskCount += r.taskCount
      }
      if (r.contextUsage != null) {
        a.totalContextUsage += r.contextUsage * r.taskCount
        a.contextUsageTaskCount += r.taskCount
      }
      if (r.toolRelevance != null) {
        a.totalToolRelevance += r.toolRelevance * r.taskCount
        a.toolRelevanceTaskCount += r.taskCount
      }
      if (r.humanLikeness != null) {
        a.totalHumanLikeness += r.humanLikeness * r.taskCount
        a.humanLikenessTaskCount += r.taskCount
      }
      a.totalDurationMs += r.avgDurationMs * r.taskCount
    }
    return Object.values(agg).map((a: any) => ({
      model: a.model,
      provider: a.provider,
      agentName: a.model,
      taskCount: a.taskCount,
      successRate: a.taskCount > 0 ? Math.round(a.totalSuccessRate / a.taskCount) : 0,
      hallucinationScore: a.taskCount > 0 ? Math.round(a.totalHallucinationScore / a.taskCount) : 60,
      outputQuality: a.taskCount > 0 ? Math.round(a.totalOutputQuality / a.taskCount) : 80,
      scopeAdherence: a.taskCount > 0 ? Math.round(a.totalScopeAdherence / a.taskCount) : 100,
      toolAccuracy: a.toolAccuracyTaskCount > 0 ? Math.round(a.totalToolAccuracy / a.toolAccuracyTaskCount) : null,
      contextUsage: a.contextUsageTaskCount > 0 ? Math.round(a.totalContextUsage / a.contextUsageTaskCount) : null,
      toolRelevance: a.toolRelevanceTaskCount > 0 ? Math.round(a.totalToolRelevance / a.toolRelevanceTaskCount) : null,
      humanLikeness: a.humanLikenessTaskCount > 0 ? Math.round(a.totalHumanLikeness / a.humanLikenessTaskCount) : null,
      avgDurationMs: a.taskCount > 0 ? Math.round(a.totalDurationMs / a.taskCount) : 0,
    }))
  }, [byAgent, latestByAgentModel, selectedAgent])

  // Unique agent list for the dropdown — only agents with completed tasks
  // and real models (not 'auto' or 'unknown') so the dropdown is meaningful.
  const agentList = useMemo(() => {
    const seen = new Set<string>()
    return byAgent.filter((a: any) => {
      if (seen.has(a.agentId)) return false
      if (a.completed === 0) return false
      if (a.model === 'auto' || a.model === 'unknown') return false
      seen.add(a.agentId)
      return true
    })
  }, [byAgent])

  // ── Compute KPI aggregates ───────────────────────────────────────────
  // Use historical byAgent for volume-weighted aggregates (quality scores
  // in byModel come from latest-execution only — weighting them by historical
  // volume would produce nonsense). Success rate is inherently volume-based
  // and correct from either source.
  const totalModels = byModel.length
  const totalTasks = byModel.reduce((s: number, m: any) => s + m.taskCount, 0)

  // Volume-weighted from historical data (correct — each (agent,task) counted once)
  const agentTotalCompleted = byAgent.reduce((s: number, a: any) => s + a.completed, 0)
  const agentTotalTasks = byAgent.reduce((s: number, a: any) => s + a.taskCount, 0)
  const avgSuccessRate = agentTotalTasks > 0
    ? Math.round((agentTotalCompleted / agentTotalTasks) * 100)
    : 0
  const avgHallucination = agentTotalTasks > 0
    ? Math.round(byAgent.reduce((s: number, a: any) => s + a.hallucinationScore * a.taskCount, 0) / agentTotalTasks)
    : 60
  const topModel = byModel.length > 0 ? byModel[0] : null

  // ── Filter agents for the selected model ──────────────────────────────
  const selectedAgents = selectedModel
    ? byAgent.filter((a: any) => a.model === selectedModel)
    : []

  const selectedAgentName = selectedAgent
    ? byAgent.find((a: any) => a.agentId === selectedAgent)?.agentName ?? selectedAgent
    : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── KPI Cards ──────────────────────────────────────────────────── */}
      <div className="stats-grid" style={{ marginBottom: 4 }}>
        <MetricCard icon="🧠" label="Models Evaluated" value={totalModels} sub={`${totalTasks.toLocaleString()} tasks benchmarked`} />
        <MetricCard icon="🏆" label="Top Performer" value={topModel ? topModel.model?.slice(0, 20) : '—'} sub={topModel ? `Fit Score ${topModel.fitScore}/100 · ${topModel.taskCount} tasks` : 'No models with completed tasks yet'} color={topModel && topModel.fitScore >= 80 ? 'var(--green)' : '#d97706'} />
        <MetricCard icon="✅" label="Avg Success Rate" value={`${avgSuccessRate}%`} sub="Weighted by task volume" color={avgSuccessRate >= 80 ? 'var(--green)' : avgSuccessRate >= 60 ? '#d97706' : '#dc2626'} />
        <MetricCard icon="🔍" label="Avg Halluc. Resistance" value={`${avgHallucination}/100`} sub="Higher = more resistant to hallucination" color={avgHallucination >= 80 ? 'var(--green)' : avgHallucination >= 60 ? '#d97706' : '#dc2626'} />
      </div>

      {/* ── Agent Selector ─────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>🤖 Agent:</span>
        <select
          value={selectedAgent || ''}
          onChange={e => {
            const v = e.target.value
            setSelectedAgent(v || null)
            if (v) setSelectedModel(null) // clear model selection when agent picked
          }}
          style={{
            padding: '6px 12px', fontSize: 13, fontWeight: 600, borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg)',
            color: 'var(--text)', cursor: 'pointer', flex: 1, maxWidth: 340,
          }}
        >
          <option value="">All agents (aggregate by model)</option>
          {agentList.map((a: any) => (
            <option key={a.agentId} value={a.agentId}>
              {a.agentName} ({a.archetype}) — {a.taskCount} tasks
            </option>
          ))}
        </select>
        {selectedAgent && (
          <button onClick={() => setSelectedAgent(null)} style={{
            fontSize: 11, fontWeight: 700, border: '1px solid var(--border)', borderRadius: 6,
            background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '5px 12px',
          }}>
            ✕ Clear agent
          </button>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          Select an agent to compare how different LLMs performed for it
        </span>
      </div>

      {/* ── Interactive Bar Chart ──────────────────────────────────────── */}
      {selectedAgent && agentModelData ? (
        <>
          <InteractiveBarChart
            byModel={[]}
            selectedModel={null}
            onSelect={() => {}}
            agentModels={agentModelData}
          />
          {agentModelData.length > 0 && (
            <div className="card" style={{ padding: 24 }}>
              <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
                🤖 LLM Performance for "{selectedAgentName}"
                {agentModelData[0]?._latest && (
                  <span style={{
                    marginLeft: 10, fontSize: 10, fontWeight: 700,
                    background: 'var(--primary-light)', color: 'var(--primary)',
                    padding: '2px 8px', borderRadius: 10, verticalAlign: 'middle',
                  }}>LATEST RUN ONLY</span>
                )}
              </h2>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
                {agentModelData[0]?._latest
                  ? 'Showing scores from the most recent completed task per model — not historical averages.'
                  : 'Historical averages across all completed tasks per model.'}
              </p>
              <table className="table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Tasks</th>
                    <th>Success</th>
                    <th>Qual.</th>
                    <th>Halluc.</th>
                    <th>Scope</th>
                    <th>Tool&nbsp;Acc.</th>
                    <th>Context</th>
                    <th>Tool&nbsp;Rel.</th>
                    <th>Human</th>
                    <th>Speed</th>
                  </tr>
                </thead>
                <tbody>
                  {agentModelData
                    .sort((a: any, b: any) => b.taskCount - a.taskCount)
                    .map((m: any) => (
                    <tr key={m.model}>
                      <td style={{ fontWeight: 700 }}>{m.model}</td>
                      <td>{m.taskCount}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <MiniBar value={m.successRate} max={100} color={scoreColor(m.successRate)} />
                          <span style={{ fontWeight: 700, color: scoreColor(m.successRate), minWidth: 34 }}>{m.successRate}%</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <MiniBar value={m.outputQuality} max={100} color={scoreColor(m.outputQuality)} />
                          <span style={{ fontWeight: 700, color: scoreColor(m.outputQuality), minWidth: 34 }}>{m.outputQuality}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <MiniBar value={m.hallucinationScore} max={100} color={scoreColor(m.hallucinationScore)} />
                          <span style={{ fontWeight: 700, color: scoreColor(m.hallucinationScore), minWidth: 34 }}>{m.hallucinationScore}</span>
                        </div>
                      </td>
                      <td>
                        <MiniBar value={m.scopeAdherence} max={100} color={scoreColor(m.scopeAdherence)} />
                      </td>
                      <td>
                        {m.toolAccuracy != null ? (
                          <MiniBar value={m.toolAccuracy} max={100} color={scoreColor(m.toolAccuracy)} />
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td>
                        {m.contextUsage != null ? (
                          <MiniBar value={m.contextUsage} max={100} color={scoreColor(m.contextUsage)} />
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>n/a</span>
                        )}
                      </td>
                      <td>
                        {m.toolRelevance != null ? (
                          <MiniBar value={m.toolRelevance} max={100} color={scoreColor(m.toolRelevance)} />
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td>
                        {m.humanLikeness != null ? (
                          <MiniBar value={m.humanLikeness} max={100} color={scoreColor(m.humanLikeness)} />
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td>{fmtDuration(m.avgDurationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <InteractiveBarChart byModel={byModel} selectedModel={selectedModel} onSelect={setSelectedModel} />
      )}

      {/* ── Agent Drill-Down (visible when model selected) ─────────────── */}
      {selectedModel && <AgentDrillDown agents={selectedAgents} />}

      {/* ── Model Adoption Cards ───────────────────────────────────────── */}
      {!selectedAgent && (<>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
        {byModel.map((m: any, i: number) => (
          <div key={m.model} className="card" style={{
            padding: 20, borderLeft: '4px solid',
            borderLeftColor: i === 0 ? 'var(--green)' : i === 1 ? '#93c5fd' : i === 2 ? '#fcd34d' : 'var(--border)',
            display: 'flex', flexDirection: 'column', gap: 12,
            cursor: 'pointer',
            outline: selectedModel === m.model ? '2px solid var(--green)' : 'none',
            transition: 'outline 0.15s ease',
          }} onClick={() => setSelectedModel(selectedModel === m.model ? null : m.model)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.3, marginBottom: 2 }}>{m.model}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{m.provider}</div>
              </div>
              <span style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 800,
                background: m.fitScore >= 80 ? '#d1fae5' : m.fitScore >= 60 ? '#fef3c7' : '#fee2e2',
                color: m.fitScore >= 80 ? '#065f46' : m.fitScore >= 60 ? '#92400e' : '#991b1b',
              }}>
                {m.fitScore}/100
              </span>
            </div>

            {/* Agent adoption: how many agents/companies use this model */}
            <div style={{ display: 'flex', gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Adopted by</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text)' }}>{m.agents} <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>agents</span></div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Tasks Run</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text)' }}>{m.taskCount.toLocaleString()}</div>
              </div>
            </div>

            {/* Progress bars */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 70 }}>Success</span>
                <MiniBar value={m.successRate} max={100} color={scoreColor(m.successRate)} />
                <span style={{ fontSize: 11, fontWeight: 700, color: scoreColor(m.successRate), minWidth: 32 }}>{m.successRate}%</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 70 }}>Hallucination</span>
                <MiniBar value={m.hallucinationScore} max={100} color={scoreColor(m.hallucinationScore)} />
                <span style={{ fontSize: 11, fontWeight: 700, color: scoreColor(m.hallucinationScore), minWidth: 32 }}>{m.hallucinationScore}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 70 }}>Speed</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{fmtDuration(m.avgDurationMs)}</span>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.avgTokens.toLocaleString()} avg tokens</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.avgActions} actions/task</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Ranked Leaderboard ─────────────────────────────────────────── */}
      <div className="card" style={{ padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700 }}>🏆 Model Fit Score Leaderboard</h2>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
          Composite score: success (20%), quality (20%), hallucination (15%), tool accuracy (15%), human-likeness (10%), tool relevance (10%), speed (10%).
        </p>
        <table className="table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Model</th>
              <th>Agents</th>
              <th>Tasks</th>
              <th>Success</th>
              <th>Qual.</th>
              <th>Scope</th>
              <th>Tool&nbsp;Acc</th>
              <th>Halluc.</th>
              <th>Context</th>
              <th>Tool&nbsp;Rel.</th>
              <th>Human</th>
              <th>Speed</th>
              <th>Fit</th>
            </tr>
          </thead>
          <tbody>
            {byModel.map((m: any, i: number) => (
              <tr key={m.model}
                onClick={() => setSelectedModel(selectedModel === m.model ? null : m.model)}
                style={{
                  cursor: 'pointer',
                  background: selectedModel === m.model ? 'var(--green-pale)' : 'transparent',
                  transition: 'background 0.15s ease',
                }}
              >
                <td style={{ fontWeight: 800, color: i === 0 ? 'var(--green)' : 'var(--text-muted)' }}>
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                </td>
                <td style={{ fontWeight: 700 }}>{m.model}</td>
                <td>{m.agents}</td>
                <td>{m.taskCount}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MiniBar value={m.successRate} max={100} color={scoreColor(m.successRate)} />
                    <span style={{ fontWeight: 700, color: scoreColor(m.successRate), minWidth: 34 }}>{m.successRate}%</span>
                  </div>
                </td>
                <td>
                  <MiniBar value={m.outputQuality ?? 80} max={100} color={scoreColor(m.outputQuality ?? 80)} />
                </td>
                <td>
                  <MiniBar value={m.scopeAdherence ?? 100} max={100} color={scoreColor(m.scopeAdherence ?? 100)} />
                </td>
                <td>
                  {m.toolAccuracy != null ? (
                    <MiniBar value={m.toolAccuracy} max={100} color={scoreColor(m.toolAccuracy)} />
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                  )}
                </td>
                <td>
                  <MiniBar value={m.hallucinationScore} max={100} color={scoreColor(m.hallucinationScore)} />
                </td>
                <td>
                  {m.contextUsage != null ? (
                    <MiniBar value={m.contextUsage} max={100} color={scoreColor(m.contextUsage)} />
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>n/a</span>
                  )}
                </td>
                <td>
                  {m.toolRelevance != null ? (
                    <MiniBar value={m.toolRelevance} max={100} color={scoreColor(m.toolRelevance)} />
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                  )}
                </td>
                <td>
                  {m.humanLikeness != null ? (
                    <MiniBar value={m.humanLikeness} max={100} color={scoreColor(m.humanLikeness)} />
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                  )}
                </td>
                <td>{fmtDuration(m.avgDurationMs)}</td>
                <td>
                  <span style={{
                    fontWeight: 800, padding: '3px 10px', borderRadius: 20,
                    background: m.fitScore >= 80 ? '#d1fae5' : m.fitScore >= 60 ? '#fef3c7' : '#fee2e2',
                    color: m.fitScore >= 80 ? '#065f46' : m.fitScore >= 60 ? '#92400e' : '#991b1b',
                  }}>
                    {m.fitScore}/100
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>)}

    </div>
  )
}
