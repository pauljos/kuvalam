'use client'
import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import { Activity, AlertTriangle, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'

type Agent = {
  agent_id: string
  agent_name?: string
  circuit_state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
  circuit_reason?: string | null
  circuit_opened_at?: string | null
  running_tasks: number
  completed_24h: number
  failed_24h: number
  cancelled_24h: number
  avg_latency_ms?: number | null
  avg_cost_usd?: number | null
  last_task_at?: string | null
  last_success_at?: string | null
  last_failure_at?: string | null
}

type MemoryEntry = {
  id: string
  entity_type: string
  entity_name: string
  detail?: string | null
  source_agent?: string | null
  visibility: 'TENANT' | 'PRIVATE'
  last_seen_at: string
}

const STATE_COLOR: Record<string, string> = {
  CLOSED: '#16a34a',
  HALF_OPEN: '#d97706',
  OPEN: '#dc2626',
}

function fmtAgo(ts?: string | null): string {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 0) return 'in the future'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function SupervisorPage() {
  const { tenantId, toast } = useApp()
  const [agents, setAgents] = useState<Agent[]>([])
  const [memory, setMemory] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [ticking, setTicking] = useState(false)
  const [addForm, setAddForm] = useState<{ entityType: string; entityName: string; detail: string } | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (tid: string) => {
    try {
      setLoading(true)
      const [health, mem] = await Promise.all([
        api.getSupervisorHealth(tid).catch(() => []),
        api.listTenantMemory(tid).catch(() => []),
      ])
      setAgents(Array.isArray(health) ? health : (health?.agents || []))
      setMemory(Array.isArray(mem) ? mem : (mem?.entries || []))
    } catch (e: any) {
      toast('error', 'Failed to load supervisor data', e?.message || '')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    if (tenantId) load(tenantId)
    else setLoading(false)
  }, [tenantId, load])

  // Auto-refresh every 15s
  useEffect(() => {
    if (!tenantId) return
    const timer = setInterval(() => load(tenantId), 15_000)
    return () => clearInterval(timer)
  }, [tenantId, load])

  const runTick = async () => {
    if (!tenantId) return
    try {
      setTicking(true)
      await api.supervisorTick(tenantId)
      toast('success', 'Supervisor tick complete', 'Fleet health refreshed')
      await load(tenantId)
    } catch (e: any) {
      toast('error', 'Tick failed', e?.message || '')
    } finally {
      setTicking(false)
    }
  }

  const resetCircuit = async (agentId: string) => {
    if (!tenantId) return
    try {
      await api.resetAgentCircuit(tenantId, agentId)
      toast('success', 'Circuit reset', 'Agent is now CLOSED')
      await load(tenantId)
    } catch (e: any) {
      toast('error', 'Reset failed', e?.message || '')
    }
  }

  const addMem = async () => {
    if (!tenantId || !addForm) return
    setAdding(true)
    try {
      const entry = await api.createTenantMemory(tenantId, addForm)
      setMemory(prev => [entry?.data || entry, ...prev])
      setAddForm(null)
      toast('success', 'Entry added', `${addForm.entityName} stored in shared memory`)
    } catch (e: any) {
      toast('error', 'Add failed', e?.message || '')
    } finally {
      setAdding(false)
    }
  }

  const deleteMem = async (id: string) => {
    if (!tenantId) return
    if (!confirm('Delete this shared memory entry?')) return
    try {
      await api.deleteTenantMemoryEntry(tenantId, id)
      setMemory(memory.filter(m => m.id !== id))
    } catch (e: any) {
      toast('error', 'Delete failed', e?.message || '')
    }
  }

  const totals = agents.reduce(
    (acc, a) => {
      acc.running += a.running_tasks || 0
      acc.completed += a.completed_24h || 0
      acc.failed += a.failed_24h || 0
      if (a.circuit_state !== 'CLOSED') acc.open++
      return acc
    },
    { running: 0, completed: 0, failed: 0, open: 0 }
  )

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <ShieldAlert size={22} strokeWidth={2} /> Supervisor
          </h1>
          <p style={{ color: '#64748b', fontSize: 14, margin: '4px 0 0' }}>
            Fleet health, circuit breakers, and shared tenant memory.
          </p>
        </div>
        <button
          onClick={runTick}
          disabled={ticking}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
            border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff',
            cursor: ticking ? 'wait' : 'pointer', fontSize: 13, fontWeight: 600,
          }}
        >
          <RefreshCw size={14} className={ticking ? 'kv-spin' : ''} />
          {ticking ? 'Ticking…' : 'Run tick now'}
        </button>
      </header>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 24 }}>
        <Kpi label="Agents tracked" value={agents.length} />
        <Kpi label="Running now" value={totals.running} />
        <Kpi label="Completed (24h)" value={totals.completed} tone="good" />
        <Kpi label="Failed (24h)" value={totals.failed} tone={totals.failed > 0 ? 'bad' : 'neutral'} />
        <Kpi label="Open breakers" value={totals.open} tone={totals.open > 0 ? 'bad' : 'good'} />
      </div>

      {/* Fleet health table */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity size={16} /> Fleet Health
        </h2>
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: '#f8fafc', textAlign: 'left' }}>
              <tr>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Agent</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>State</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Running</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>24h ✓ / ✗</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Avg latency</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Last task</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>Loading…</td></tr>
              )}
              {!loading && agents.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>No agent health data yet — run a tick to populate.</td></tr>
              )}
              {agents.map(a => (
                <tr key={a.agent_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 12 }}>
                    {a.agent_name || a.agent_id.slice(0, 8)}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '2px 8px', borderRadius: 999,
                      background: `${STATE_COLOR[a.circuit_state]}15`,
                      color: STATE_COLOR[a.circuit_state],
                      fontWeight: 600, fontSize: 11,
                    }} title={a.circuit_reason || ''}>
                      {a.circuit_state !== 'CLOSED' && <AlertTriangle size={11} />}
                      {a.circuit_state}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>{a.running_tasks}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ color: '#16a34a', fontWeight: 600 }}>{a.completed_24h}</span>
                    {' / '}
                    <span style={{ color: a.failed_24h > 0 ? '#dc2626' : '#94a3b8', fontWeight: 600 }}>{a.failed_24h}</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {a.avg_latency_ms != null ? `${(a.avg_latency_ms / 1000).toFixed(1)}s` : '—'}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#64748b' }}>{fmtAgo(a.last_task_at)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    {a.circuit_state !== 'CLOSED' && (
                      <button
                        onClick={() => resetCircuit(a.agent_id)}
                        style={{
                          padding: '4px 10px', border: '1px solid #e2e8f0', borderRadius: 6,
                          background: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600,
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Tenant memory */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Shared Tenant Memory</h2>
          <button
            onClick={() => setAddForm({ entityType: '', entityName: '', detail: '' })}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          ><Plus size={13} /> Add entry
          </button>
        </div>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 12 }}>
          Cross-agent facts written by agents with the <code>write_tenant_memory</code> scope.
        </p>
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: '#f8fafc', textAlign: 'left' }}>
              <tr>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Type</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Name</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Detail</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Last seen</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}></th>
              </tr>
            </thead>
            <tbody>
              {addForm && (
                <tr style={{ background: '#f8fafc' }}>
                  <td style={{ padding: '8px 10px' }}>
                    <input
                      placeholder="Type (e.g. CUSTOMER)"
                      value={addForm.entityType}
                      onChange={e => setAddForm(f => f && { ...f, entityType: e.target.value.toUpperCase() })}
                      style={{ width: '100%', padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: 5, fontSize: 12 }}
                    />
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <input
                      placeholder="Name"
                      value={addForm.entityName}
                      onChange={e => setAddForm(f => f && { ...f, entityName: e.target.value })}
                      style={{ width: '100%', padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: 5, fontSize: 12 }}
                    />
                  </td>
                  <td style={{ padding: '8px 10px' }} colSpan={2}>
                    <input
                      placeholder="Detail / context (optional)"
                      value={addForm.detail}
                      onChange={e => setAddForm(f => f && { ...f, detail: e.target.value })}
                      style={{ width: '100%', padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: 5, fontSize: 12 }}
                    />
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button disabled={adding || !addForm.entityType || !addForm.entityName} onClick={addMem}
                      style={{ padding: '4px 10px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', marginRight: 4 }}>
                      {adding ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={() => setAddForm(null)}
                      style={{ padding: '4px 10px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 5, fontSize: 12, cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </td>
                </tr>
              )}
              {!loading && memory.length === 0 && !addForm && !addForm && (
                <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>No shared memory entries yet. Click &ldquo;Add entry&rdquo; to seed facts.</td></tr>
              )}
              {memory.map(m => (
                <tr key={m.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ padding: '1px 6px', borderRadius: 4, background: '#f1f5f9', fontSize: 11, fontWeight: 600 }}>
                      {m.entity_type}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>{m.entity_name}</td>
                  <td style={{ padding: '10px 14px', color: '#475569', maxWidth: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.detail || '—'}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#64748b' }}>{fmtAgo(m.last_seen_at)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    <button
                      onClick={() => deleteMem(m.id)}
                      title="Delete entry"
                      style={{
                        padding: 4, border: 'none', background: 'transparent',
                        cursor: 'pointer', color: '#94a3b8',
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <style dangerouslySetInnerHTML={{ __html: `@keyframes kv-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } } .kv-spin { animation: kv-spin 1s linear infinite; }` }} />
    </div>
  )
}

function Kpi({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: 'good' | 'bad' | 'neutral' }) {
  const color = tone === 'good' ? '#16a34a' : tone === 'bad' ? '#dc2626' : '#0f172a'
  return (
    <div style={{ padding: 16, border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' }}>
      <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
    </div>
  )
}
