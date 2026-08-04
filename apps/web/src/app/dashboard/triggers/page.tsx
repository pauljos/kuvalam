'use client'
import { useEffect, useState, useCallback } from 'react'
import { useApp } from '@/lib/context'
import { api, API } from '@/lib/api'
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
  agent_name?: string
  agent_id?: string
  agent_prompt?: string
  target_type?: string
  is_active: boolean
  config: any
  created_at: string
  last_fired_at?: string
  fire_count?: number
}

interface Workflow { id: string; name: string }
interface Agent { id: string; name: string; archetype: string }

export default function TriggersPage() {
  const { tenantId, toast } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', workflowId: '', triggerType: 'WEBHOOK', targetType: 'WORKFLOW', agentId: '', agentPrompt: '', cron: '0 9 * * *', cronCustom: false, eventType: 'agent.completed', condition: '' })
  const [creating, setCreating] = useState(false)
  const [webhookSecret, setWebhookSecret] = useState<{ id: string; url: string; secret: string } | null>(null)
  const [showSecret, setShowSecret] = useState(false)
  const [testingTrigger, setTestingTrigger] = useState<string | null>(null)
  const [editingTrigger, setEditingTrigger] = useState<Trigger | null>(null)

  const load = useCallback(async () => {
    if (!tenantId) return
    setLoading(true)
    try {
      const [triggersData, workflowsData, agentsData] = await Promise.all([
        api.listTriggers(tenantId),
        api.listWorkflows(tenantId),
        api.listAgents(tenantId),
      ])
      setTriggers(Array.isArray(triggersData) ? triggersData : [])
      const wfData = workflowsData?.workflows || (Array.isArray(workflowsData) ? workflowsData : [])
      setWorkflows(wfData)
      setAgents(agentsData?.agents || [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [tenantId])

  useEffect(() => { load() }, [load])

  async function createTrigger(e: React.FormEvent) {
    e.preventDefault()
    
    // Validation
    if (!form.name.trim()) {
      toast('error', 'Name required', 'Please enter a trigger name.')
      return
    }
    if (form.targetType === 'WORKFLOW' && !form.workflowId) {
      toast('error', 'Workflow required', 'Please select a workflow.')
      return
    }
    if (form.targetType === 'AGENT' && !form.agentId) {
      toast('error', 'Agent required', 'Please select an agent.')
      return
    }
    if (form.targetType === 'AGENT' && !form.agentPrompt.trim()) {
      toast('error', 'Prompt required', 'Please enter a prompt for the agent.')
      return
    }
    if (form.triggerType === 'SCHEDULE' && form.cronCustom && !form.cron.trim()) {
      toast('error', 'Schedule required', 'Please enter a cron expression.')
      return
    }
    if (form.triggerType === 'CONDITION' && !form.condition.trim()) {
      toast('error', 'Condition required', 'Please enter a condition expression.')
      return
    }
    
    setCreating(true)
    const config: any = {}
    if (form.triggerType === 'SCHEDULE') config.cron = form.cron
    if (form.triggerType === 'EVENT') config.eventType = form.eventType
    if (form.triggerType === 'CONDITION') config.condition = form.condition
    try {
      const body: any = {
        name: form.name,
        triggerType: form.triggerType,
        targetType: form.targetType,
        config,
      }
      if (form.targetType === 'WORKFLOW') {
        body.workflowId = form.workflowId
      } else {
        body.agentId = form.agentId
        body.agentPrompt = form.agentPrompt
      }

      if (editingTrigger) {
        await api.updateTrigger(tenantId, editingTrigger.id, body)
        toast('success', 'Trigger updated', `"${form.name}" has been saved.`)
      } else {
        const created = await api.createTrigger(tenantId, body)
        if (form.triggerType === 'WEBHOOK' && created.config?.secret) {
          setWebhookSecret({
            id: created.id,
            url: `${API}/tenants/${tenantId}/triggers/webhook/${created.id}`,
            secret: created.config.secret,
          })
        } else {
          toast('success', 'Trigger created', `"${form.name}" is now active.`)
        }
      }
      setShowCreate(false)
      setEditingTrigger(null)
      setForm({ name: '', workflowId: '', triggerType: 'WEBHOOK', targetType: 'WORKFLOW', agentId: '', agentPrompt: '', cron: '0 9 * * *', cronCustom: false, eventType: 'agent.completed', condition: '' })
      load()
    } catch (err: any) {
      toast('error', editingTrigger ? 'Update failed' : 'Create failed', err.message)
    } finally {
      setCreating(false)
    }
  }

  async function toggleTrigger(id: string, current: boolean) {
    try {
      await api.updateTrigger(tenantId, id, { is_active: !current })
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
      await api.deleteTrigger(tenantId, id)
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

  async function testFireTrigger(trigger: Trigger) {
    setTestingTrigger(trigger.id)
    try {
      if (trigger.target_type === 'AGENT') {
        await api.dispatchTask(tenantId, trigger.agent_id!, {
          goal: trigger.agent_prompt || `Trigger: ${trigger.name}`,
          context: { test: true, triggerId: trigger.id, triggerType: trigger.trigger_type }
        })
        toast('success', 'Agent triggered', `"${trigger.agent_name}" task created from trigger.`)
      } else {
        await api.startWorkflowExecution(tenantId, trigger.workflow_id, { 
          context: { test: true, triggerId: trigger.id, triggerType: trigger.trigger_type } 
        })
        toast('success', 'Workflow triggered', `"${trigger.workflow_name}" execution started from trigger.`)
      }
    } catch (err: any) {
      if (err.status === 429) {
        toast('warning', 'Too many executions', err.message || 'Concurrent execution limit reached. Try again shortly.')
      } else {
        toast('error', 'Test fire failed', err.message)
      }
    } finally {
      setTestingTrigger(null)
    }
  }

  const [searchQuery, setSearchQuery] = useState('')
  const filteredTriggers = triggers.filter(t =>
    !searchQuery || t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.workflow_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.agent_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.trigger_type?.toLowerCase().includes(searchQuery.toLowerCase())
  )
  const activeCount = triggers.filter(t => t.is_active).length

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Triggers</h1>
          <p className="page-sub">Run workflows automatically on webhooks, schedules, and events</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setEditingTrigger(null); setForm({ name: '', workflowId: '', triggerType: 'WEBHOOK', targetType: 'WORKFLOW', agentId: '', agentPrompt: '', cron: '0 9 * * *', cronCustom: false, eventType: 'agent.completed', condition: '' }); setShowCreate(true) }}>+ New Trigger</button>
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
            <div key={tt.id} className="card card-hover" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 22, marginBottom: 8 }}>{tt.icon}</div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{tt.label}</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>{tt.description}</p>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <h2 style={{ fontSize: 17, fontWeight: 800 }}>Your Triggers</h2>
            {triggers.length > 0 && (
              <input
                className="input"
                placeholder="Search triggers..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ maxWidth: 260, padding: '8px 12px', fontSize: 13 }}
              />
            )}
          </div>
          {loading ? (
            <div className="skeleton" style={{ height: 300, borderRadius: 12 }} />
          ) : triggers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>⚡</div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>No triggers yet</div>
              <div style={{ fontSize: 13, marginBottom: 18 }}>Create a webhook, schedule, or event trigger to automate your workflows.</div>
              <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Create First Trigger</button>
            </div>
          ) : filteredTriggers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>🔍</div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>No triggers match &ldquo;{searchQuery}&rdquo;</div>
              <div style={{ fontSize: 13 }}>Try a different search term.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
              {filteredTriggers.map(t => {
                const tt = TRIGGER_TYPES.find(x => x.id === t.trigger_type)
                return (
                  <div key={t.id} className="card card-hover" style={{
                    padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
                    border: t.is_active ? '1px solid var(--green-border)' : '1px solid var(--border)',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.04)',
                  }}>
                    {/* Top accent gradient bar */}
                    <div style={{
                      height: 4, flexShrink: 0,
                      background: t.is_active
                        ? 'linear-gradient(90deg, #10b981, #34d399)'
                        : 'linear-gradient(90deg, #9ca3af, #d1d5db)',
                    }} />

                    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {/* Top row: icon tile + name + status */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{
                          width: 46, height: 46, borderRadius: 14, flexShrink: 0,
                          background: t.is_active
                            ? 'linear-gradient(135deg, #d1fae5, #a7f3d0)'
                            : 'linear-gradient(135deg, #f3f4f6, #e5e7eb)',
                          border: `1.5px solid ${t.is_active ? 'var(--green-border)' : 'var(--border)'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 23,
                          boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.6)',
                        }}>{tt?.icon || '⚡'}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                            <h3 style={{ fontWeight: 800, fontSize: 15, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</h3>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#e0e7ff', color: '#3730a3' }}>{tt?.label}</span>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {t.target_type === 'AGENT' ? (
                              <>🤖 Agent: <strong>{t.agent_name || t.agent_id?.substring(0, 8)}</strong></>
                            ) : (
                              <>⟳ Workflow: <strong>{t.workflow_name}</strong></>
                            )}
                          </div>
                        </div>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                          background: t.is_active ? '#d1fae5' : '#f3f4f6',
                          color: t.is_active ? '#065f46' : '#6b7280',
                          border: `1px solid ${t.is_active ? '#a7f3d0' : '#e5e7eb'}`,
                          whiteSpace: 'nowrap', flexShrink: 0,
                          display: 'flex', alignItems: 'center', gap: 5,
                          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5)',
                        }}>
                          <span style={{
                            width: 6, height: 6, borderRadius: '50%',
                            background: t.is_active ? '#10b981' : '#9ca3af', flexShrink: 0,
                            animation: t.is_active ? 'blink 1.8s ease-in-out infinite' : undefined,
                          }} />
                          {t.is_active ? 'Active' : 'Paused'}
                        </span>
                      </div>

                      {/* Detail chips */}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {t.trigger_type === 'SCHEDULE' && t.config?.cron && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: '#fffbeb', color: '#854d0e', border: '1px solid #fde68a' }}>
                            🕐 {describeCron(t.config.cron)}
                          </span>
                        )}
                        {t.trigger_type === 'WEBHOOK' && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                            🔗 HMAC-signed POST
                          </span>
                        )}
                        {t.trigger_type === 'EVENT' && t.config?.eventType && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: '#f5f3ff', color: '#5b21b6', border: '1px solid #ddd6fe' }}>
                            ⚡ on {t.config.eventType}
                          </span>
                        )}
                        {t.trigger_type === 'CONDITION' && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' }}>
                            🎯 Condition
                          </span>
                        )}
                        {t.fire_count > 0 && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: '#f3f4f6', color: '#4b5563', border: '1px solid #e5e7eb' }}>
                            🔥 {t.fire_count} fires
                          </span>
                        )}
                      </div>

                      {/* Last fired */}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
                        {t.last_fired_at
                          ? <>Last fired: {new Date(t.last_fired_at).toLocaleString()}</>
                          : t.is_active
                          ? 'Never fired yet'
                          : 'Not scheduled'}
                      </div>

                      {/* Action buttons */}
                      <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 4 }}>
                        <button className="btn btn-secondary btn-sm" style={{ flex: 1 }} onClick={() => testFireTrigger(t)} title="Test trigger by firing workflow" disabled={testingTrigger === t.id}>
                          {testingTrigger === t.id ? '⏳' : '🔥'} Test
                        </button>
                        <button className="btn btn-secondary btn-sm" style={{ flex: 1 }} onClick={() => toggleTrigger(t.id, t.is_active)}>
                          {t.is_active ? '⏸ Pause' : '▶ Enable'}
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => {
                          setEditingTrigger(t)
                          setForm({
                            name: t.name,
                            workflowId: t.workflow_id || '',
                            triggerType: t.trigger_type,
                            targetType: t.target_type || 'WORKFLOW',
                            agentId: t.agent_id || '',
                            agentPrompt: t.agent_prompt || '',
                            cron: t.config?.cron || '0 9 * * *',
                            cronCustom: false,
                            eventType: t.config?.eventType || 'agent.completed',
                            condition: t.config?.condition || '',
                          })
                          setShowCreate(true)
                        }} title="Edit" style={{ padding: '0 10px' }}>✏️</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => duplicateTrigger(t.id)} title="Duplicate" style={{ padding: '0 10px' }}>⧉</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => deleteTrigger(t.id, t.name)} title="Delete trigger" style={{ padding: '0 10px', color: '#ef4444' }}>🗑</button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Create / Edit Trigger Modal */}
      {showCreate && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h2 className="modal-title">{editingTrigger ? 'Edit Trigger' : 'New Trigger'}</h2>
              <button onClick={() => { setShowCreate(false); setEditingTrigger(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)' }}>✕</button>
            </div>
            <form onSubmit={createTrigger}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="form-group">
                  <label className="form-label">Trigger Name *</label>
                  <input className="input" placeholder="e.g. Daily Morning Report" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Target Type *</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['WORKFLOW', 'AGENT'].map(tt => (
                      <label key={tt} style={{
                        flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                        borderRadius: 8, cursor: 'pointer',
                        border: `1px solid ${form.targetType === tt ? 'var(--green)' : 'var(--border)'}`,
                        background: form.targetType === tt ? 'var(--green-bg)' : 'var(--bg-white)',
                      }}>
                        <input type="radio" name="targetType" value={tt} checked={form.targetType === tt}
                          onChange={() => setForm(f => ({ ...f, targetType: tt }))}
                          style={{ accentColor: 'var(--green)' }} />
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{tt === 'WORKFLOW' ? '📋 Workflow' : '🤖 Agent'}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {form.targetType === 'WORKFLOW' ? (
                  <div className="form-group">
                    <label className="form-label">Workflow *</label>
                    <select className="input" value={form.workflowId} onChange={e => setForm(f => ({ ...f, workflowId: e.target.value }))} required>
                      <option value="">Select workflow…</option>
                      {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </div>
                ) : (
                  <>
                    <div className="form-group">
                      <label className="form-label">Agent *</label>
                      <select className="input" value={form.agentId} onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))} required>
                        <option value="">Select agent…</option>
                        {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.archetype})</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Agent Prompt *</label>
                      <textarea className="input" rows={3} placeholder="e.g. Run a daily sales report and post it to Slack"
                        value={form.agentPrompt}
                        onChange={e => setForm(f => ({ ...f, agentPrompt: e.target.value }))}
                        required />
                      <span className="form-hint">The goal/prompt the agent will execute when the trigger fires.</span>
                    </div>
                  </>
                )}
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
                <button type="button" className="btn btn-secondary" onClick={() => { setShowCreate(false); setEditingTrigger(null) }}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={creating}>{creating ? 'Saving...' : editingTrigger ? 'Save Changes' : 'Create Trigger'}</button>
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
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input 
                    className="input" 
                    readOnly 
                    type={showSecret ? 'text' : 'password'}
                    value={webhookSecret.secret} 
                    style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }} 
                  />
                  <button 
                    type="button"
                    className="btn btn-secondary btn-sm" 
                    onClick={() => setShowSecret(!showSecret)}
                    style={{ minWidth: 60 }}
                    title={showSecret ? 'Hide secret' : 'Show secret'}
                  >
                    {showSecret ? '👁️ Hide' : '👁️ Show'}
                  </button>
                  <button 
                    className="btn btn-secondary btn-sm" 
                    onClick={() => { 
                      navigator.clipboard.writeText(webhookSecret.secret)
                      toast('success', 'Copied!', '') 
                    }}
                    title="Copy secret to clipboard"
                  >
                    Copy
                  </button>
                </div>
                <span className="form-hint" style={{ marginTop: 6, display: 'block', color: '#d97706' }}>
                  ⚠️ This secret will not be shown again. Save it securely now.
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Sign requests with: <code style={{ background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>X-Kuvalam-Signature: sha256=&lt;hmac&gt;</code>
                <br />
                <strong style={{ marginTop: 8, display: 'block' }}>Example (Node.js):</strong>
                <pre style={{ background: 'var(--bg)', padding: 8, borderRadius: 4, fontSize: 11, marginTop: 4, overflowX: 'auto' }}>
{`const crypto = require('crypto');
const signature = 'sha256=' + crypto
  .createHmac('sha256', SECRET)
  .update(JSON.stringify(body))
  .digest('hex');
  
fetch(webhookUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Kuvalam-Signature': signature
  },
  body: JSON.stringify(body)
});`}
                </pre>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => { 
                setWebhookSecret(null)
                setShowSecret(false)
                toast('success', 'Trigger created', 'Webhook is active.') 
              }}>Done</button>
            </div>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  )
}
