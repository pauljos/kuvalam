'use client'
import { useEffect, useState, useCallback } from 'react'
import { useApp } from '@/lib/context'
import { api } from '@/lib/api'
import { useConfirm } from '@/components/ConfirmModal'

const TRIGGER_TYPES = [
  { id: 'WEBHOOK', icon: '🔗', label: 'Webhook', description: 'Trigger via HTTP POST to a unique URL with HMAC signature verification.' },
  { id: 'SCHEDULE', icon: '🕐', label: 'Schedule', description: 'Run on a cron schedule (e.g. every hour, daily at 9am).' },
  { id: 'EVENT', icon: '⚡', label: 'Event', description: 'Fire when a platform event occurs (agent completed, approval granted, etc.).' },
  { id: 'CONDITION', icon: '🎯', label: 'Condition', description: 'Evaluate a condition on new data — trigger when it becomes true.' },
]

const CRON_PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every day at 9am', value: '0 9 * * *' },
  { label: 'Every weekday at 8am', value: '0 8 * * 1-5' },
  { label: 'Every Sunday at midnight', value: '0 0 * * 0' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Custom...', value: '' },
]

function describeCron(cron: string): string {
  const map: Record<string, string> = {
    '0 * * * *': 'Every hour',
    '0 9 * * *': 'Every day at 9:00 AM',
    '0 8 * * 1-5': 'Weekdays at 8:00 AM',
    '0 0 * * 0': 'Sundays at midnight',
    '*/15 * * * *': 'Every 15 minutes',
  }
  return map[cron] || cron
}

interface Trigger {
  id: string
  name: string
  trigger_type: string
  workflow_name: string
  workflow_id: string
  is_active: boolean
  config: any
  created_at: string
  last_fired_at?: string
  fire_count?: number
}

interface Workflow { id: string; name: string }

export default function TriggersPage() {
  const { tenantId, toast } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', workflowId: '', triggerType: 'WEBHOOK', cron: '0 9 * * *', cronCustom: false, eventType: 'agent.completed', condition: '' })
  const [creating, setCreating] = useState(false)
  const [webhookSecret, setWebhookSecret] = useState<{ id: string; url: string; secret: string } | null>(null)

  const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'

  const load = useCallback(async () => {
    if (!tenantId) return
    setLoading(true)
    try {
      const [tRes, wRes] = await Promise.all([
        fetch(`${API}/tenants/${tenantId}/triggers`, { credentials: 'include' }),
        fetch(`${API}/tenants/${tenantId}/workflows`, { credentials: 'include' }),
      ])
      if (tRes.ok) setTriggers((await tRes.json()).data || [])
      if (wRes.ok) setWorkflows((await wRes.json()).data || [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [tenantId, API])

  useEffect(() => { load() }, [load])

  async function createTrigger(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    const config: any = {}
    if (form.triggerType === 'SCHEDULE') config.cron = form.cron
    if (form.triggerType === 'EVENT') config.eventType = form.eventType
    if (form.triggerType === 'CONDITION') config.condition = form.condition
    try {
      const res = await fetch(`${API}/tenants/${tenantId}/triggers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ workflowId: form.workflowId, triggerType: form.triggerType, name: form.name, config }),
      })
      if (!res.ok) throw new Error((await res.json()).message || 'Create failed')
      const created = (await res.json()).data
      if (form.triggerType === 'WEBHOOK' && created.config?.secret) {
        setWebhookSecret({
          id: created.id,
          url: `${API}/tenants/${tenantId}/triggers/webhook/${created.id}`,
          secret: created.config.secret,
        })
      } else {
        toast('success', 'Trigger created', `"${form.name}" is now active.`)
      }
      setShowCreate(false)
      setForm({ name: '', workflowId: '', triggerType: 'WEBHOOK', cron: '0 9 * * *', cronCustom: false, eventType: 'agent.completed', condition: '' })
      load()
    } catch (err: any) {
      toast('error', 'Create failed', err.message)
    } finally {
      setCreating(false)
    }
  }

  async function toggleTrigger(id: string, current: boolean) {
    try {
      const res = await fetch(`${API}/tenants/${tenantId}/triggers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_active: !current }),
      })
      if (!res.ok) throw new Error('Update failed')
      setTriggers(prev => prev.map(t => t.id === id ? { ...t, is_active: !current } : t))
      toast('success', current ? 'Trigger paused' : 'Trigger enabled', '')
    } catch (err: any) { toast('error', 'Update failed', err.message) }
  }

  async function deleteTrigger(id: string, name: string) {
    const ok = await confirm({
      title: `Delete trigger "${name}"?`,
      description: 'The workflow will no longer be triggered automatically. This action cannot be undone.',
      confirmLabel: 'Delete trigger',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await fetch(`${API}/tenants/${tenantId}/triggers/${id}`, { method: 'DELETE', credentials: 'include' })
      setTriggers(prev => prev.filter(t => t.id !== id))
      toast('info', 'Trigger deleted', '')
    } catch (err: any) { toast('error', 'Delete failed', err.message) }
  }

  async function duplicateTrigger(id: string) {
    try {
      const clone = await api.duplicateTrigger(tenantId, id)
      setTriggers(prev => [clone, ...prev])
      toast('success', 'Trigger duplicated', `Created "${clone.name}" (paused).`)
    } catch (err: any) {
      toast('error', 'Duplicate failed', err.message)
    }
  }

  const activeCount = triggers.filter(t => t.is_active).length

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Triggers</h1>
          <p className="page-sub">Run workflows automatically on webhooks, schedules, and events</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Trigger</button>
      </div>

      <div className="page-body">
        <div className="stats-grid" style={{ marginBottom: 24 }}>
          {[
            { label: 'Total Triggers', value: triggers.length, icon: '⚡', color: '#7c3aed' },
            { label: 'Active', value: activeCount, icon: '✅', color: '#059669' },
            { label: 'Paused', value: triggers.length - activeCount, icon: '⏸', color: '#d97706' },
            { label: 'Total Fires', value: triggers.reduce((n, t) => n + (t.fire_count || 0), 0), icon: '🔥', color: '#ef4444' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div style={{ fontSize: 26, fontWeight: 900, color: s.color }}>{s.icon} {s.value}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Trigger type info */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 24 }}>
          {TRIGGER_TYPES.map(tt => (
            <div key={tt.id} className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 22, marginBottom: 8 }}>{tt.icon}</div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{tt.label}</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>{tt.description}</p>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 28 }}>
          <h2 style={{ fontSize: 17, fontWeight: 800, marginBottom: 20 }}>Your Triggers</h2>
          {loading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading...</div>
          ) : triggers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>⚡</div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>No triggers yet</div>
              <div style={{ fontSize: 13, marginBottom: 18 }}>Create a webhook, schedule, or event trigger to automate your workflows.</div>
              <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Create First Trigger</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {triggers.map(t => {
                const tt = TRIGGER_TYPES.find(x => x.id === t.trigger_type)
                return (
                  <div key={t.id} style={{
                    display: 'flex', alignItems: 'center', gap: 16, padding: '16px 20px',
                    borderRadius: 10,
                    border: `1px solid ${t.is_active ? 'var(--green-border)' : 'var(--border)'}`,
                    background: t.is_active ? 'var(--green-bg)' : 'var(--bg)',
                  }}>
                    <div style={{ fontSize: 26 }}>{tt?.icon || '⚡'}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{t.name}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#e0e7ff', color: '#3730a3' }}>{tt?.label}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 }}>
                        Workflow: <strong>{t.workflow_name}</strong>
                        {t.trigger_type === 'SCHEDULE' && t.config?.cron && ` · ${describeCron(t.config.cron)}`}
                        {t.trigger_type === 'WEBHOOK' && ' · HMAC-signed POST'}
                        {t.trigger_type === 'EVENT' && t.config?.eventType && ` · on ${t.config.eventType}`}
                      </div>
                      {t.last_fired_at && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          Last fired: {new Date(t.last_fired_at).toLocaleString()} · {t.fire_count || 0} total fires
                        </div>
                      )}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: t.is_active ? '#d1fae5' : '#f3f4f6', color: t.is_active ? '#065f46' : '#9ca3af' }}>
                      {t.is_active ? 'Active' : 'Paused'}
                    </span>
                    <button className="btn btn-secondary btn-sm" onClick={() => toggleTrigger(t.id, t.is_active)}>
                      {t.is_active ? 'Pause' : 'Enable'}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => duplicateTrigger(t.id)} title="Duplicate">⧉</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => deleteTrigger(t.id, t.name)} style={{ color: '#ef4444' }}>Delete</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Create Trigger Modal */}
      {showCreate && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h2 className="modal-title">New Trigger</h2>
              <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)' }}>✕</button>
            </div>
            <form onSubmit={createTrigger}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="form-group">
                  <label className="form-label">Trigger Name *</label>
                  <input className="input" placeholder="e.g. Daily Morning Report" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Workflow *</label>
                  <select className="input" value={form.workflowId} onChange={e => setForm(f => ({ ...f, workflowId: e.target.value }))} required>
                    <option value="">Select workflow…</option>
                    {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Trigger Type *</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {TRIGGER_TYPES.map(tt => (
                      <label key={tt.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                        borderRadius: 8, cursor: 'pointer',
                        border: `1px solid ${form.triggerType === tt.id ? 'var(--green)' : 'var(--border)'}`,
                        background: form.triggerType === tt.id ? 'var(--green-bg)' : 'var(--bg-white)',
                      }}>
                        <input type="radio" name="triggerType" value={tt.id} checked={form.triggerType === tt.id} onChange={() => setForm(f => ({ ...f, triggerType: tt.id }))} style={{ accentColor: 'var(--green)' }} />
                        <span style={{ fontSize: 18 }}>{tt.icon}</span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{tt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {form.triggerType === 'SCHEDULE' && (
                  <div className="form-group">
                    <label className="form-label">Schedule</label>
                    <select className="input" value={form.cronCustom ? '' : form.cron} onChange={e => {
                      if (e.target.value === '') setForm(f => ({ ...f, cronCustom: true }))
                      else setForm(f => ({ ...f, cron: e.target.value, cronCustom: false }))
                    }}>
                      {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                    {form.cronCustom && (
                      <input className="input" style={{ marginTop: 8 }} placeholder="Cron expression (e.g. 0 9 * * 1-5)" value={form.cron} onChange={e => setForm(f => ({ ...f, cron: e.target.value }))} />
                    )}
                    {form.cron && <span className="form-hint">{describeCron(form.cron)}</span>}
                  </div>
                )}

                {form.triggerType === 'EVENT' && (
                  <div className="form-group">
                    <label className="form-label">Event Type</label>
                    <select className="input" value={form.eventType} onChange={e => setForm(f => ({ ...f, eventType: e.target.value }))}>
                      <option value="agent.completed">Agent task completed</option>
                      <option value="approval.granted">Approval granted</option>
                      <option value="approval.rejected">Approval rejected</option>
                      <option value="workflow.failed">Workflow failed</option>
                      <option value="knowledge.updated">Knowledge base updated</option>
                    </select>
                  </div>
                )}

                {form.triggerType === 'CONDITION' && (
                  <div className="form-group">
                    <label className="form-label">Condition Expression</label>
                    <textarea className="input" rows={3} placeholder="e.g. output.sentiment === 'negative' && output.score < 0.3" value={form.condition} onChange={e => setForm(f => ({ ...f, condition: e.target.value }))} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                    <span className="form-hint">JavaScript expression evaluated against workflow output data.</span>
                  </div>
                )}

                {form.triggerType === 'WEBHOOK' && (
                  <div className="alert alert-info" style={{ fontSize: 13 }}>
                    A unique webhook URL and HMAC-256 secret will be generated after creation. Use them to trigger this workflow from any external system.
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={creating}>{creating ? 'Creating...' : 'Create Trigger'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Webhook secret reveal modal */}
      {webhookSecret && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h2 className="modal-title">🔗 Webhook Created</h2>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="alert alert-warning" style={{ fontSize: 13 }}>
                <strong>Save these credentials now</strong> — the secret cannot be shown again.
              </div>
              <div className="form-group">
                <label className="form-label">Webhook URL</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input" readOnly value={webhookSecret.url} style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }} />
                  <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(webhookSecret.url); toast('success', 'Copied!', '') }}>Copy</button>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">HMAC Secret</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input" readOnly value={webhookSecret.secret} style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }} />
                  <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(webhookSecret.secret); toast('success', 'Copied!', '') }}>Copy</button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Sign requests with: <code style={{ background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>X-Hub-Signature-256: sha256=&lt;hmac&gt;</code>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => { setWebhookSecret(null); toast('success', 'Trigger created', 'Webhook is active.') }}>Done</button>
            </div>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  )
}
