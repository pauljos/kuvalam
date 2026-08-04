'use client'
import { useEffect, useState, useRef } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Bot, Library, RefreshCw, CheckCircle2, Plus, Activity, ArrowRight,
  ChevronDown, ChevronRight, Clock, Zap, AlertTriangle, Play, Loader2
} from 'lucide-react'

type AgentGroup = {
  id: string
  name: string
  archetype: string | null
  status: string
  llmModel: string | null
  llmProvider: string | null
  tasks: TaskSummary[]
  runningCount: number
  recentCompleted: number
  recentFailed: number
}

type TaskSummary = {
  id: string
  goal: string
  status: string
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  tokenUsage: any
  actionCount: number
  hasCheckpoint: boolean
  error: string | null
  resultPreview: string | null
}

function timeAgo(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Math.max(0, Date.now() - then)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function elapsed(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Math.max(0, Date.now() - then)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

const STATUS_COLORS: Record<string, string> = {
  RUNNING: '#3b82f6',
  PENDING: '#f59e0b',
  COMPLETED: '#22c55e',
  FAILED: '#ef4444',
  CANCELLED: '#6b7280',
  QUEUED: '#8b5cf6',
}

const STATUS_ICONS: Record<string, string> = {
  RUNNING: '⟳',
  PENDING: '⏳',
  COMPLETED: '✓',
  FAILED: '✗',
  CANCELLED: '⊘',
  QUEUED: '⏱',
}

export default function DashboardPage() {
  const { tenantId, user } = useApp()
  const router = useRouter()
  const [agents, setAgents] = useState<any[]>([])
  const [kbs, setKbs] = useState<any[]>([])
  const [tenant, setTenant] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [runningTasks, setRunningTasks] = useState(0)
  const [providerCount, setProviderCount] = useState(0)
  const [agentLogs, setAgentLogs] = useState<AgentGroup[]>([])
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const initialExpandDone = useRef<Set<string>>(new Set()) // track which agents got initial auto-expand

  // Redirect sysadmins without tenant to admin portal
  useEffect(() => {
    if (!tenantId && user?.isSystemAdmin && typeof window !== 'undefined') {
      router.push('/dashboard/admin')
    }
  }, [tenantId, user])
  const [workflowCount, setWorkflowCount] = useState(0)
  const [showAllAgents, setShowAllAgents] = useState(false)

  // Load agent logs with auto-poll for running tasks
  async function loadAgentLogs(tid: string) {
    try {
      const res = await api.getAgentLogs(tid, { limit: '40' })
      // request() already unwraps .data, so res is { agents, totalRunning }
      const groups: AgentGroup[] = res?.agents || []
      setAgentLogs(groups)
      // Auto-expand agents with running tasks on first discovery (respects user collapse after)
      setExpandedAgents(prev => {
        const next = new Set(prev)
        for (const g of groups) {
          if (g.runningCount > 0 && !initialExpandDone.current.has(g.id)) {
            next.add(g.id)
            initialExpandDone.current.add(g.id)
          }
        }
        return next
      })
      const running = groups.reduce((s, g) => s + g.runningCount, 0)
      setRunningTasks(running)
      return running
    } catch (e) {
      console.error('loadAgentLogs failed:', e)
    }
    return 0
  }

  useEffect(() => {
    const tid = tenantId
    if (!tid) return

    Promise.all([
      api.getTenant(tid).catch(() => null),
      api.listAgents(tid).catch(() => ({ agents: [] })),
      api.listKBs(tid).catch(() => ({ knowledgeBases: [] })),
      api.listApprovals(tid, 'PENDING').catch(() => []),
      api.listWorkflowExecutions(tid).catch(() => ({ executions: [] })),
      api.getSettings(tid).catch(() => null),
      api.listWorkflows(tid).catch(() => ({ workflows: [] })),
      loadAgentLogs(tid),
    ]).then(([t, a, k, appvs, execData, settings, wfs]) => {
      setTenant(t)
      setAgents(a?.agents || [])
      setKbs(k?.knowledgeBases || [])
      setPendingApprovals((appvs?.approvals || appvs || []).length)
      setProviderCount(Object.keys(settings?.llm_config?.providers || {}).length)
      setWorkflowCount((wfs?.workflows || wfs || []).length)
      setLoading(false)
    })

    // Auto-poll agent logs every 5s while tasks are running
    pollRef.current = setInterval(async () => {
      const running = await loadAgentLogs(tid)
      if (running === 0 && pollRef.current) {
        // Slow polling when nothing is running
        clearInterval(pollRef.current)
        pollRef.current = setInterval(() => loadAgentLogs(tid), 15000)
      }
    }, 5000)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [tenantId])

  const activeAgents = agents.filter(a => a.status === 'ACTIVE').length

  function toggleAgent(id: string) {
    setExpandedAgents(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tenant?.name || 'Overview'}</h1>
          <p className="page-sub">
            {loading ? '\u00a0' :
              (activeAgents === 0 && agents.length === 0)
                ? 'Set up your workspace and create your first agent to get started.'
                : `${activeAgents} active ${activeAgents === 1 ? 'agent' : 'agents'} · ${runningTasks} running · ${pendingApprovals} awaiting approval`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link href="/dashboard/agents" className="btn btn-primary btn-sm">
            <Plus size={14} strokeWidth={2.5} /> New Agent
          </Link>
        </div>
      </div>

      <div className="page-body">

        {/* ── Live metrics ──────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 28 }}>
          {[
            { label: 'Active Agents', value: loading ? '—' : activeAgents, sub: `${agents.length} total`, Icon: Bot, color: 'var(--green)' },
            { label: 'Knowledge Bases', value: loading ? '—' : kbs.length, sub: 'Document collections', Icon: Library, color: '#7c3aed' },
            { label: 'Running Now', value: loading ? '—' : runningTasks, sub: 'Live task executions', Icon: RefreshCw, color: '#0891b2' },
            { label: 'Pending Approvals', value: loading ? '—' : pendingApprovals, sub: 'Awaiting human review', Icon: CheckCircle2, color: '#d97706' },
          ].map(m => (
            <div key={m.label} className="stat-tile" style={{ position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 14, right: 14, opacity: 0.18, color: m.color }}>
                <m.Icon size={22} strokeWidth={2} />
              </div>
              <div className="stat-value" style={{ color: m.color }}>{m.value}</div>
              <div className="stat-label">{m.label}</div>
              <div className="stat-change">{m.sub}</div>
            </div>
          ))}
        </div>

        {/* ── Getting-started checklist (only shown while user has open steps) ─ */}
        {!loading && (() => {
          const steps = [
            { id: 'llm', label: 'Add an LLM provider API key', done: providerCount > 0, href: '/dashboard/settings', cta: 'Add provider' },
            { id: 'agent', label: 'Create your first agent', done: agents.length > 0, href: '/dashboard/agents', cta: 'New agent' },
            { id: 'kb', label: 'Ingest a knowledge base document', done: kbs.length > 0, href: '/dashboard/knowledge', cta: 'Upload docs' },
            { id: 'wf', label: 'Build a workflow', done: workflowCount > 0, href: '/dashboard/workflows', cta: 'Create workflow' },
          ]
          const doneCount = steps.filter(s => s.done).length
          if (doneCount === steps.length) return null

          return (
            <div className="card" style={{ padding: '22px 26px', marginBottom: 24, background: 'linear-gradient(135deg, var(--green-bg) 0%, #fefdf9 100%)', border: '1px solid var(--green-border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--green-dark)', letterSpacing: 0.6, textTransform: 'uppercase' }}>Getting Started</div>
                  <h2 style={{ fontSize: 17, fontWeight: 800, marginTop: 4 }}>Set up your workspace ({doneCount}/{steps.length} done)</h2>
                </div>
                <div style={{ width: 120, height: 6, borderRadius: 99, background: '#e5e7eb', overflow: 'hidden' }}>
                  <div style={{ width: `${(doneCount / steps.length) * 100}%`, height: '100%', background: 'var(--green)', transition: 'width 0.4s' }} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                {steps.map(s => (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10,
                    background: s.done ? '#fff' : 'rgba(255,255,255,0.7)',
                    border: `1px solid ${s.done ? 'var(--green-border)' : 'var(--border)'}`,
                    opacity: s.done ? 0.75 : 1,
                  }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                      background: s.done ? 'var(--green)' : '#fff',
                      border: `2px solid ${s.done ? 'var(--green)' : '#d1d5db'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 12, fontWeight: 900,
                    }}>{s.done ? '✓' : ''}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: s.done ? 'var(--text-muted)' : 'var(--text)', textDecoration: s.done ? 'line-through' : 'none' }}>{s.label}</div>
                    </div>
                    {!s.done && <Link href={s.href} className="btn btn-primary btn-sm" style={{ fontSize: 11, padding: '5px 10px' }}>{s.cta}</Link>}
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {/* ── Quick Actions ─────────────────────────────────────────────────── */}
        {!loading && agents.length > 0 && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
            <Link href="/dashboard/agents" className="btn btn-primary btn-sm">
              <Plus size={14} strokeWidth={2.5} /> Create Agent
            </Link>
            <Link href="/dashboard/knowledge" className="btn btn-secondary btn-sm">
              📚 Upload Document
            </Link>
            <Link href="/dashboard/workflows" className="btn btn-secondary btn-sm">
              🔧 Build Workflow
            </Link>
            <Link href="/dashboard/triggers" className="btn btn-secondary btn-sm">
              ⚡ New Trigger
            </Link>
          </div>
        )}

        {/* ── Agents table + Recent Activity ────────────────────────────────── */}
        <div className="overview-grid">
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 15, fontWeight: 800 }}>Agents ({agents.length})</h2>
              <Link href="/dashboard/agents" style={{ color: 'var(--green-dark)', fontWeight: 700, textDecoration: 'none', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                View all <ArrowRight size={13} strokeWidth={2.5} />
              </Link>
            </div>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 56 }} />)}
              </div>
            ) : agents.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon" style={{ display: 'inline-flex', color: 'var(--text-muted)' }}><Bot size={44} strokeWidth={1.5} /></span>
                <h3 className="empty-title">No agents yet</h3>
                <p className="empty-desc">Create your first AI agent and give it a goal to execute autonomously.</p>
                <Link href="/dashboard/agents" className="btn btn-primary">Create First Agent</Link>
              </div>
            ) : (
              <>
                <table className="table">
                  <thead>
                    <tr><th>Agent</th><th>Model</th><th>Status</th><th></th></tr>
                  </thead>
                  <tbody>
                    {(showAllAgents ? agents : agents.slice(0, 6)).map(agent => (
                      <tr key={agent.id}>
                        <td style={{ fontWeight: 700 }}>
                          <Link href={`/dashboard/agents/${agent.id}`} style={{ textDecoration: 'none', color: 'var(--text)' }}>
                            {agent.name}
                          </Link>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>{agent.archetype}</div>
                        </td>
                        <td><span className="tag" style={{ fontSize: 11 }}>{agent.llm_model === 'auto' || !agent.llm_model ? 'System default' : agent.llm_model}</span></td>
                        <td><span className={`badge badge-${agent.status.toLowerCase()}`}>{agent.status}</span></td>
                        <td><Link href={`/dashboard/agents/${agent.id}`} className="btn btn-secondary btn-sm">Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {agents.length > 6 && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowAllAgents(!showAllAgents)}
                    style={{ marginTop: 12, width: '100%', justifyContent: 'center', fontSize: 13 }}
                  >
                    {showAllAgents ? `Show less (${6})` : `Show all (${agents.length})`}
                  </button>
                )}
              </>
            )}
          </div>

          {/* Agent Execution Log — grouped by agent, running tasks first */}
          <div className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ fontSize: 15, fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Activity size={15} strokeWidth={2.5} /> Agent Execution Log
                {runningTasks > 0 && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, background: '#3b82f6', color: '#fff',
                    padding: '2px 8px', borderRadius: 99, display: 'inline-flex', alignItems: 'center', gap: 4
                  }}>
                    <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} /> {runningTasks} running
                  </span>
                )}
              </h2>
              <Link href="/dashboard/audit" style={{ color: 'var(--green-dark)', fontWeight: 700, textDecoration: 'none', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Full audit log <ArrowRight size={12} strokeWidth={2.5} />
              </Link>
            </div>

            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{ height: 48 }} />)}
              </div>
            ) : agentLogs.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '18px 4px', lineHeight: 1.5, textAlign: 'center' }}>
                <Play size={24} strokeWidth={1.5} style={{ opacity: 0.3, marginBottom: 8 }} />
                <div>No task executions yet.</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Dispatch a task to an agent to see it here.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '70vh', overflowY: 'auto' }}>
                {agentLogs.map(group => {
                  const isExpanded = expandedAgents.has(group.id)
                  const isRunning = group.runningCount > 0
                  const isDeleted = group.status === 'DELETED'

                  return (
                    <div key={group.id} style={{
                      border: `1px solid ${isRunning ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                      borderRadius: 10,
                      overflow: 'hidden',
                      background: isRunning ? 'rgba(59,130,246,0.03)' : 'transparent',
                    }}>
                      {/* Agent header */}
                      <div
                        onClick={() => toggleAgent(group.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                          cursor: 'pointer', userSelect: 'none',
                          background: isRunning ? 'rgba(59,130,246,0.06)' : 'var(--bg-secondary)',
                        }}
                      >
                        {isExpanded
                          ? <ChevronDown size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                          : <ChevronRight size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                        }
                        <Bot size={15} strokeWidth={2} style={{ color: isDeleted ? 'var(--text-muted)' : 'var(--green)', flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 }}>
                            {isDeleted ? group.name : (
                              <Link
                                href={`/dashboard/agents/${group.id}`}
                                onClick={e => e.stopPropagation()}
                                style={{ color: 'var(--text)', textDecoration: 'none' }}
                                onMouseOver={e => e.currentTarget.style.color = 'var(--green-dark)'}
                                onMouseOut={e => e.currentTarget.style.color = 'var(--text)'}
                              >
                                {group.name}
                              </Link>
                            )}
                            {group.archetype && (
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{group.archetype}</span>
                            )}
                          </div>
                          {(group.llmModel || group.llmProvider) && (
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <Zap size={10} style={{ flexShrink: 0 }} />
                              {group.llmProvider && <span style={{ opacity: 0.7 }}>{group.llmProvider}/</span>}
                              <span style={{ fontWeight: 500 }}>{group.llmModel}</span>
                            </div>
                          )}
                        </div>

                        {/* Mini stats */}
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
                          {group.runningCount > 0 && (
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', display: 'flex', alignItems: 'center', gap: 3 }}>
                              <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} />
                              {group.runningCount} running
                            </span>
                          )}
                          {group.recentCompleted > 0 && (
                            <span style={{ fontSize: 11, color: '#22c55e' }}>{group.recentCompleted} done</span>
                          )}
                          {group.recentFailed > 0 && (
                            <span style={{ fontSize: 11, color: '#ef4444' }}>{group.recentFailed} failed</span>
                          )}
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 28, textAlign: 'right' }}>
                            {group.tasks.length} tasks
                          </span>
                        </div>
                      </div>

                      {/* Task list (collapsible) */}
                      {isExpanded && (
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          {group.tasks.slice(0, 10).map(task => {
                            const isTaskRunning = task.status === 'RUNNING' || task.status === 'PENDING'
                            const taskColor = STATUS_COLORS[task.status] || 'var(--text-muted)'
                            const taskIcon = STATUS_ICONS[task.status] || '·'
                            const tokens = task.tokenUsage?.total_tokens || task.tokenUsage?.totalTokens || 0

                            return (
                              <Link
                                key={task.id}
                                href={`/dashboard/agents/${group.id}`}
                                onClick={e => {
                                  // Store task ID in sessionStorage so the agent page can load it
                                  try { sessionStorage.setItem(`task-select-${group.id}`, task.id) } catch {}
                                }}
                                style={{
                                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 14px 9px 36px',
                                  borderTop: '1px solid var(--border)', textDecoration: 'none', color: 'inherit',
                                  opacity: task.status === 'CANCELLED' ? 0.5 : 1,
                                }}
                                onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                                onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                              >
                                {/* Status indicator */}
                                <div style={{
                                  width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                                  background: taskColor, color: '#fff', fontSize: 10,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontWeight: 900,
                                  ...(isTaskRunning ? { animation: 'pulse 2s infinite' } : {})
                                }}>
                                  {isTaskRunning ? <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} /> : taskIcon}
                                </div>

                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {task.goal || '(untitled)'}
                                  </div>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                    <span style={{ color: taskColor, fontWeight: 700 }}>{task.status}</span>
                                    {isTaskRunning && task.startedAt && (
                                      <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                                        <Clock size={10} /> {elapsed(task.startedAt)}
                                      </span>
                                    )}
                                    {!isTaskRunning && <span>{timeAgo(task.completedAt || task.createdAt)}</span>}
                                    {task.actionCount > 0 && <span>· {task.actionCount} actions</span>}
                                    {tokens > 0 && <span>· {tokens.toLocaleString()} tokens</span>}
                                    {task.error && (
                                      <span style={{ color: '#ef4444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}
                                        title={task.error}>
                                        <AlertTriangle size={10} style={{ display: 'inline', marginRight: 2 }} />
                                        {task.error.replace(/\n.*/s, '').slice(0, 80)}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </Link>
                            )
                          })}
                          {group.tasks.length > 10 && (
                            <div style={{ padding: '8px 14px 8px 36px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
                              +{group.tasks.length - 10} more tasks —
                              <Link href={`/dashboard/agents/${group.id}`} style={{ color: 'var(--green-dark)', fontWeight: 600, marginLeft: 4 }}>
                                view all
                              </Link>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
