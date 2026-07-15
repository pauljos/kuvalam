'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import Link from 'next/link'
import {
  Bot, Library, RefreshCw, CheckCircle2, Plus, Activity, ArrowRight
} from 'lucide-react'

type AuditEntry = {
  id: string
  event_type: string
  actor_type?: string
  actor_id?: string
  resource_type?: string | null
  resource_id?: string | null
  action?: string | null
  created_at: string
  metadata?: Record<string, unknown>
}

function timeAgo(iso: string): string {
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

function humaniseEvent(ev: string): string {
  // Turn "connector.tested" / "AGENT_CREATED" into "Connector tested" / "Agent created"
  const s = ev.replace(/[._]/g, ' ').toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export default function DashboardPage() {
  const { tenantId, user } = useApp()
  const [agents, setAgents] = useState<any[]>([])
  const [kbs, setKbs] = useState<any[]>([])
  const [tenant, setTenant] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [runningTasks, setRunningTasks] = useState(0)
  const [providerCount, setProviderCount] = useState(0)
  
  // Redirect sysadmins without tenant to admin portal
  useEffect(() => {
    if (!tenantId && user?.isSystemAdmin && typeof window !== 'undefined') {
      window.location.href = '/dashboard/admin'
    }
  }, [tenantId, user])
  const [workflowCount, setWorkflowCount] = useState(0)
  const [activity, setActivity] = useState<AuditEntry[]>([])

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
      api.listAuditLog(tid, { limit: '8' }).catch(() => ({ logs: [] })),
    ]).then(([t, a, k, appvs, execData, settings, wfs, audit]) => {
      setTenant(t)
      setAgents(a?.agents || [])
      setKbs(k?.knowledgeBases || [])
      setPendingApprovals((appvs?.approvals || appvs || []).length)
      const execsList = execData?.executions || execData || []
      setRunningTasks(execsList.filter((e: any) => e && ['RUNNING', 'PENDING_APPROVAL'].includes(e.status)).length)
      setProviderCount(Object.keys(settings?.llm_config?.providers || {}).length)
      setWorkflowCount((wfs?.workflows || wfs || []).length)
      setActivity(Array.isArray(audit?.logs) ? audit.logs : [])
      setLoading(false)
    })
  }, [tenantId])

  const activeAgents = agents.filter(a => a.status === 'ACTIVE').length

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

        {/* ── Agents table + Recent Activity ────────────────────────────────── */}
        <div className="overview-grid">
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 15, fontWeight: 800 }}>Agents</h2>
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
              <table className="table">
                <thead>
                  <tr><th>Agent</th><th>Model</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {agents.slice(0, 6).map(agent => (
                    <tr key={agent.id}>
                      <td style={{ fontWeight: 700 }}>
                        <Link href={`/dashboard/agents/${agent.id}`} style={{ textDecoration: 'none', color: 'var(--text)' }}>
                          {agent.name}
                        </Link>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>{agent.archetype}</div>
                      </td>
                      <td><span className="tag" style={{ fontSize: 11 }}>{agent.llm_model}</span></td>
                      <td><span className={`badge badge-${agent.status.toLowerCase()}`}>{agent.status}</span></td>
                      <td><Link href={`/dashboard/agents/${agent.id}`} className="btn btn-secondary btn-sm">Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Recent Activity */}
          <div className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ fontSize: 15, fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Activity size={15} strokeWidth={2.5} /> Recent Activity
              </h2>
              <Link href="/dashboard/audit" style={{ color: 'var(--green-dark)', fontWeight: 700, textDecoration: 'none', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Audit log <ArrowRight size={12} strokeWidth={2.5} />
              </Link>
            </div>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{ height: 34 }} />)}
              </div>
            ) : activity.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '18px 4px', lineHeight: 1.5 }}>
                No activity yet. Actions performed by you and your agents will appear here.
              </div>
            ) : (
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2, margin: 0, padding: 0 }}>
                {activity.slice(0, 8).map(entry => (
                  <li key={entry.id} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '10px 4px', borderBottom: '1px solid var(--border)',
                  }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%', marginTop: 6, flexShrink: 0,
                      background: entry.actor_type === 'SYSTEM' ? 'var(--text-muted)' :
                                  entry.actor_type === 'AGENT' ? 'var(--green)' : '#0891b2'
                    }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {humaniseEvent(entry.event_type)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span>{timeAgo(entry.created_at)}</span>
                        {entry.resource_type && <span>· {entry.resource_type.toLowerCase()}</span>}
                        {entry.actor_type && entry.actor_type !== 'SYSTEM' && <span>· {entry.actor_type.toLowerCase()}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
