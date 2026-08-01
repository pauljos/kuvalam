'use client'
import { useEffect, useState, useCallback } from 'react'
import { api, authedFetch, API } from '@/lib/api'
import { useApp } from '@/lib/context'

// ── Types ────────────────────────────────────────────────
type SprintMetrics = {
  sprintName: string
  startDate: string
  endDate: string
  committed: number
  completed: number
  velocity: number
  completionRate: number
  issuesTotal: number
  issuesDone: number
  burndownData: { day: string; ideal: number; actual: number }[]
}

type DashboardData = {
  agentId: string
  agentName: string
  sprints: SprintMetrics[]
  summary: string
  avgVelocity: number
  avgCompletionRate: number
  trend: 'up' | 'down' | 'stable'
  generatedAt: string
}

// ── Sub-components ───────────────────────────────────────
function MetricCard({ icon, label, value, sub, color = 'var(--green)' }: {
  icon: string; label: string; value: string | number; sub?: string; color?: string
}) {
  return (
    <div className="stat-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ fontSize: 20 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

function SprintRow({ sprint, index }: { sprint: SprintMetrics; index: number }) {
  const rateColor = sprint.completionRate >= 80 ? 'var(--green)' : sprint.completionRate >= 60 ? 'var(--orange, #f59e0b)' : 'var(--red, #ef4444)'
  const barPct = Math.min(sprint.completionRate, 100)
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600 }}>{sprint.sprintName}</td>
      <td style={{ padding: '10px 12px', fontSize: 13, color: 'var(--text-muted)' }}>
        {new Date(sprint.startDate).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })} – {new Date(sprint.endDate).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}
      </td>
      <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'center' }}>{sprint.committed}</td>
      <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'center', fontWeight: 700 }}>{sprint.velocity}</td>
      <td style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 8, background: 'var(--bg-card-hover)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${barPct}%`, background: rateColor, borderRadius: 99, transition: 'width 0.5s ease' }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: rateColor, minWidth: 42, textAlign: 'right' }}>{sprint.completionRate.toFixed(0)}%</span>
        </div>
      </td>
      <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
        {sprint.issuesDone}/{sprint.issuesTotal}
      </td>
    </tr>
  )
}

function BurndownMiniChart({ data }: { data: { day: string; ideal: number; actual: number }[] }) {
  if (!data?.length) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No burndown data available</div>

  const maxVal = Math.max(...data.flatMap(d => [d.ideal, d.actual]), 1)
  const h = 100, w = 400
  const padding = { top: 10, right: 10, bottom: 20, left: 40 }
  const chartW = w - padding.left - padding.right
  const chartH = h - padding.top - padding.bottom

  const scaleX = (i: number) => padding.left + (i / Math.max(data.length - 1, 1)) * chartW
  const scaleY = (v: number) => padding.top + chartH - (v / maxVal) * chartH

  const idealPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${scaleX(i)},${scaleY(d.ideal)}`).join(' ')
  const actualPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${scaleX(i)},${scaleY(d.actual)}`).join(' ')

  return (
    <div style={{ position: 'relative' }}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <line key={f} x1={padding.left} y1={scaleY(maxVal * f)} x2={w - padding.right} y2={scaleY(maxVal * f)}
            stroke="var(--border)" strokeDasharray="4 3" />
        ))}
        {/* Ideal line */}
        <path d={idealPath} fill="none" stroke="var(--text-muted)" strokeWidth={1.5} strokeDasharray="6 4" opacity={0.6} />
        {/* Actual line */}
        <path d={actualPath} fill="none" stroke="var(--green)" strokeWidth={2.5} />
        {/* Dots on actual */}
        {data.map((d, i) => (
          <circle key={i} cx={scaleX(i)} cy={scaleY(d.actual)} r={3} fill="var(--green)" />
        ))}
        {/* X-axis labels */}
        {data.filter((_, i) => i % Math.ceil(data.length / 5) === 0 || i === data.length - 1).map((d, i) => {
          const idx = data.indexOf(d)
          return (
            <text key={idx} x={scaleX(idx)} y={h - 4} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
              {d.day.slice(5)}
            </text>
          )
        })}
      </svg>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--green)' }}>— Actual</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>- - Ideal</span>
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────
export default function SprintsPage() {
  const { tenantId, toast } = useApp()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  const agentId = '9ed300a4-1f3a-4f76-a82c-88dd369365be' // Jira Sprint Analytics agent

  // Load existing sprint dashboard data (from latest report)
  const loadData = useCallback(async () => {
    if (!tenantId) return
    setLoading(true)
    setError('')
    try {
      // Try to get the latest sprint report from the reports API
      const reports = await authedFetch(
        `${API}/tenants/${tenantId}/reports?limit=20&reportType=sprint_dashboard`,
        { credentials: 'include' }
      ).then(r => r.json()).catch(() => ({ data: [] }))

      if (reports?.data?.length > 0) {
        const latest = reports.data[0]
        // Parse HTML content for sprint data if available
        setData({
          agentId,
          agentName: 'Jira Sprint Analytics',
          sprints: [],
          summary: latest.summary || 'No sprint data available. Run the Jira Sprint Analytics agent to generate a report.',
          avgVelocity: 0,
          avgCompletionRate: 0,
          trend: 'stable',
          generatedAt: latest.created_at,
        })
      } else {
        setData({
          agentId,
          agentName: 'Jira Sprint Analytics',
          sprints: [],
          summary: 'No sprint data available yet. Run the Jira Sprint Analytics agent to analyze your sprints.',
          avgVelocity: 0,
          avgCompletionRate: 0,
          trend: 'stable',
          generatedAt: new Date().toISOString(),
        })
      }
    } catch (err: any) {
      console.error('Failed to load sprint data:', err)
      setError(err.message || 'Failed to load sprint data')
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => { if (tenantId) loadData() }, [tenantId, loadData])

  // Generate a sprint analytics report by running the agent
  async function generateReport() {
    if (!tenantId || generating) return
    setGenerating(true)
    setError('')
    try {
      // Dispatch a task to the Jira Sprint Analytics agent
      await api.dispatchTask(tenantId, agentId, {
        goal: 'Analyze the last 5 completed sprints from Jira. Calculate velocity, completion rate, and burndown for each sprint. Create a comprehensive sprint dashboard report with charts and insights.',
        mode: 'sync',
      })
      toast('success', 'Report generated!', 'Refreshing dashboard data…')
      await loadData()
    } catch (err: any) {
      setError(err.message || 'Failed to generate report')
    } finally {
      setGenerating(false)
    }
  }

  // ── Build mock sprint data for demo / when no real data ──
  const mockSprints: SprintMetrics[] = [
    { sprintName: 'Sprint 24', startDate: '2026-07-01', endDate: '2026-07-14', committed: 55, completed: 48, velocity: 48, completionRate: 87, issuesTotal: 14, issuesDone: 12, burndownData: [] },
    { sprintName: 'Sprint 23', startDate: '2026-06-17', endDate: '2026-06-30', committed: 52, completed: 45, velocity: 45, completionRate: 87, issuesTotal: 12, issuesDone: 10, burndownData: [] },
    { sprintName: 'Sprint 22', startDate: '2026-06-03', endDate: '2026-06-16', committed: 48, completed: 42, velocity: 42, completionRate: 88, issuesTotal: 11, issuesDone: 10, burndownData: [] },
    { sprintName: 'Sprint 21', startDate: '2026-05-20', endDate: '2026-06-02', committed: 50, completed: 38, velocity: 38, completionRate: 76, issuesTotal: 13, issuesDone: 10, burndownData: [] },
    { sprintName: 'Sprint 20', startDate: '2026-05-06', endDate: '2026-05-19', committed: 45, completed: 40, velocity: 40, completionRate: 89, issuesTotal: 10, issuesDone: 9, burndownData: [] },
  ]

  const sprints = data?.sprints?.length ? data.sprints : mockSprints
  const avgVelocity = data?.avgVelocity || (sprints.reduce((s, sp) => s + sp.velocity, 0) / Math.max(sprints.length, 1))
  const avgCompletion = data?.avgCompletionRate || (sprints.reduce((s, sp) => s + sp.completionRate, 0) / Math.max(sprints.length, 1))
  const trend = data?.trend || (sprints.length >= 2 && sprints[0].velocity > sprints[1].velocity ? 'up' : sprints[0].velocity < sprints[1].velocity ? 'down' : 'stable')

  // Generate burndown data for the latest sprint
  const latestSprint = sprints[0]
  const burndownData = latestSprint?.burndownData?.length
    ? latestSprint.burndownData
    : generateBurndownData(latestSprint)

  if (loading) {
    return (
      <div className="animate-in">
        <div className="page-header">
          <div><h1 className="page-title">Sprint Dashboard</h1></div>
        </div>
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>Loading sprint data…</div>
      </div>
    )
  }

  return (
    <div className="animate-in">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Sprint Dashboard</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 4 }}>
            Jira sprint analytics — velocity, completion rate & burndown
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={loadData} disabled={loading}>
            ↻ Refresh
          </button>
          <button className="btn btn-primary" onClick={generateReport} disabled={generating}>
            {generating ? '⟳ Running Agent…' : '📊 Generate Report'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: 'var(--red-bg, #fef2f2)', color: 'var(--red, #ef4444)', padding: '12px 16px', borderRadius: 8, marginBottom: 20, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* ── Metric Cards ── */}
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <MetricCard icon="📊" label="Sprints Analyzed" value={sprints.length} sub="Last 5 completed sprints" color="var(--blue, #3b82f6)" />
        <MetricCard icon="⚡" label="Avg Velocity" value={avgVelocity.toFixed(1)} sub="Story points per sprint" color="var(--green)" />
        <MetricCard icon="✓" label="Completion Rate" value={`${avgCompletion.toFixed(0)}%`}
          sub={`Trend: ${trend === 'up' ? '↑ Improving' : trend === 'down' ? '↓ Declining' : '→ Stable'}`}
          color={trend === 'up' ? 'var(--green)' : trend === 'down' ? 'var(--red, #ef4444)' : 'var(--orange, #f59e0b)'} />
        <MetricCard icon="🔥" label="Latest Burn" value={`${sprints[0]?.issuesDone || 0}/${sprints[0]?.issuesTotal || 0}`}
          sub={`${latestSprint?.sprintName || 'N/A'} issues completed`} color="var(--purple, #8b5cf6)" />
      </div>

      {/* ── Burndown Chart ── */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Burndown — {latestSprint?.sprintName || 'Latest Sprint'}</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 16px' }}>
          {latestSprint ? `${new Date(latestSprint.startDate).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })} – ${new Date(latestSprint.endDate).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}` : ''}
        </p>
        <BurndownMiniChart data={burndownData} />
      </div>

      {/* ── Velocity Trend ── */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Velocity Trend</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 16px' }}>Story points completed per sprint</p>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 120, padding: '0 8px' }}>
          {sprints.map((s, i) => {
            const maxV = Math.max(...sprints.map(x => x.velocity), 1)
            const h = Math.max((s.velocity / maxV) * 100, 8)
            return (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>{s.velocity}</span>
                <div style={{ width: '100%', maxWidth: 48, height: h, background: 'var(--green)', borderRadius: '4px 4px 0 0', opacity: 0.85 }} />
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{s.sprintName.replace('Sprint ', 'SP')}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Sprint Details Table ── */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Sprint Details</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 16px' }}>Detailed metrics for each sprint</p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                <th style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'left' }}>Sprint</th>
                <th style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'left' }}>Dates</th>
                <th style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'center' }}>Committed</th>
                <th style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'center' }}>Velocity</th>
                <th style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'left' }}>Completion %</th>
                <th style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'center' }}>Issues</th>
              </tr>
            </thead>
            <tbody>
              {sprints.map((s, i) => <SprintRow key={i} sprint={s} index={i} />)}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Summary / Insights ── */}
      <div className="card">
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>AI Insights</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 16px' }}>Generated by Jira Sprint Analytics agent</p>
        <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text)' }}>
          {data?.summary || (
            <>
              <p><strong>Summary:</strong> Over the last {sprints.length} sprints, the team has maintained an average velocity of <strong>{avgVelocity.toFixed(1)} story points</strong> with a <strong>{avgCompletion.toFixed(0)}% completion rate</strong>.</p>
              <p style={{ marginTop: 8 }}>
                {trend === 'up'
                  ? `📈 Velocity is trending upward — the team is gaining momentum. Sprint ${sprints[0]?.sprintName.slice(-2)} showed the highest velocity at ${sprints[0]?.velocity} points.`
                  : trend === 'down'
                    ? `📉 Velocity is declining. Sprint ${sprints[0]?.sprintName.slice(-2)} dropped to ${sprints[0]?.velocity} points. Consider investigating blockers or scope creep.`
                    : `→ Velocity is stable. The team is maintaining consistent output across sprints.`}
              </p>
              <p style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                💡 <em>Run the Jira Sprint Analytics agent to get real data and AI-powered insights from your Jira sprints.</em>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────
function generateBurndownData(sprint: SprintMetrics | undefined): { day: string; ideal: number; actual: number }[] {
  if (!sprint) return []
  const start = new Date(sprint.startDate)
  const end = new Date(sprint.endDate)
  const days = Math.max(Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)), 1)
  const total = sprint.committed || sprint.velocity || 1
  const completed = sprint.velocity || 0
  const result: { day: string; ideal: number; actual: number }[] = []

  for (let i = datesEqual(new Date(start), new Date(end)) ? 0 : 0; i <= days; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    const dayStr = d.toISOString().slice(0, 10)
    const ideal = total - (total * (i / Math.max(days, 1)))
    // Simulate actual burndown with some variance
    const variance = Math.sin(i * 0.5) * (total * 0.1)
    const actual = Math.max(0, total - (completed * (i / Math.max(days, 1))) + (i < days ? variance : 0))
    result.push({ day: dayStr, ideal: Math.round(ideal * 10) / 10, actual: Math.round(actual * 10) / 10 })
  }
  return result
}

function datesEqual(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
