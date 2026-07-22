'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import Link from 'next/link'
import { useConfirm } from '@/components/ConfirmModal'

const ARCHETYPES = ['Planner', 'Research', 'Compliance', 'Document', 'Communication', 'Analytics', 'Coordinator']

const PROMPT_TEMPLATES = [
  { label: 'Data Analyst', prompt: 'You are an expert Data Analyst agent. Your goal is to analyze provided datasets, compute key metrics, identify trends, and generate comprehensive summary reports.\n\nRULES:\n1. Always verify data formatting before processing.\n2. Summarize key findings in clear markdown tables.\n3. Do not hallucinate data.' },
  { label: 'Software Engineer', prompt: 'You are an autonomous Software Engineering agent. Your role is to write clean, maintainable, and efficient code.\n\nRULES:\n1. Plan your architecture before writing code.\n2. Always include basic test coverage for logic.\n3. Ensure code conforms to modern linting standards.' },
  { label: 'Research Assistant', prompt: 'You are a meticulous Research Assistant. Your role is to gather information, synthesize long documents, and provide accurate, cited summaries.\n\nRULES:\n1. Extract key facts and list them as bullet points.\n2. Do not invent information.\n3. When asked to summarize, maintain the original tone.' },
  { label: 'Customer Support', prompt: 'You are a polite and empathetic Customer Support agent. Your role is to resolve user issues efficiently while maintaining a professional tone.\n\nRULES:\n1. Always start by acknowledging the user\'s frustration or issue.\n2. Provide step-by-step solutions.\n3. Escalate to a human if the issue cannot be resolved.' }
];

// Providers whose model catalogue is user-defined (Ollama pulls, LM Studio loads, etc.)
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'localai', 'custom'])

// Fallback display labels — used if the tenant has a provider we don't recognise
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode',
  groq: 'Groq',
  mistral: 'Mistral',
  ollama: 'Ollama (Local)',
  lmstudio: 'LM Studio (Local)',
  localai: 'LocalAI (Local)',
  custom: 'Custom (Local)',
}

export default function AgentsPage() {
  const { tenantId, toast } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [hasLlmProvider, setHasLlmProvider] = useState<boolean | null>(null)
  const [llmProviders, setLlmProviders] = useState<Record<string, { model?: string; baseUrl?: string }>>({})
  const [form, setForm] = useState({
    name: '', description: '', archetype: '', autonomyLevel: 'SUPERVISED',
    llmProvider: 'openai', llmModel: 'gpt-4o',
    systemPrompt: '', confidenceThreshold: 0.75
  })
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!tenantId) return
    api.listAgents(tenantId).then(r => { setAgents(r.agents || []); setLoading(false) })
    api.getSettings(tenantId).then(s => {
      const providers = s?.llm_config?.providers || {}
      setLlmProviders(providers)
      setHasLlmProvider(Object.keys(providers).length > 0)
      // Seed form with the tenant default so the first agent inherits it
      const def = s?.llm_config?.defaultProvider
      if (def && providers[def]) {
        setForm(f => ({ ...f, llmProvider: def, llmModel: providers[def].model || f.llmModel }))
      }
    }).catch(() => setHasLlmProvider(false))
  }, [tenantId])

  const set = (k: string) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function createAgent(e: any) {
    e.preventDefault(); setCreating(true); setError('')
    try {
      const agent = await api.createAgent(tenantId, form)
      setAgents(a => [agent, ...a])
      setShowCreate(false)
      setForm({ name: '', description: '', archetype: '', autonomyLevel: 'SUPERVISED', llmProvider: 'openai', llmModel: 'gpt-4o', systemPrompt: '', confidenceThreshold: 0.75 })
      toast('success', 'Agent created', `"${agent.name}" is ready to configure.`)
    } catch (err: any) { setError(err.message) } finally { setCreating(false) }
  }

  async function activate(agentId: string) {
    try {
      const updated = await api.activateAgent(tenantId, agentId)
      setAgents(a => a.map(x => x.id === agentId ? { ...x, status: updated.status } : x))
      toast('success', 'Agent activated', 'The agent is now live and ready to accept tasks.')
    } catch (err: any) { toast('error', 'Activation failed', err.message) }
  }

  async function duplicate(agentId: string) {
    const agent = agents.find(a => a.id === agentId)
    const ok = await confirm({
      title: `Duplicate "${agent?.name || 'this agent'}"?`,
      description: 'A copy will be created in DRAFT status with the same configuration. You can then edit and activate it separately.',
      confirmLabel: 'Duplicate',
    })
    if (!ok) return
    try {
      const clone = await api.duplicateAgent(tenantId, agentId)
      setAgents(a => [clone, ...a])
      toast('success', 'Agent duplicated', `Created "${clone.name}".`)
    } catch (err: any) { toast('error', 'Duplicate failed', err.message) }
  }

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Agents</h1>
          <p className="page-sub">Configure, activate, and run your AI agents</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Create Agent</button>
      </div>

      <div className="page-body">
        {hasLlmProvider === false && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px',
            background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10,
            marginBottom: 20,
          }}>
            <span style={{ fontSize: 22 }}>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#854d0e' }}>No LLM provider configured</div>
              <div style={{ fontSize: 12, color: '#a16207', marginTop: 2 }}>Agents need an LLM API key to think. Add one before running any task.</div>
            </div>
            <Link href="/dashboard/settings" className="btn btn-primary btn-sm">Configure now →</Link>
          </div>
        )}

        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 180 }} />)}
          </div>
        ) : agents.length === 0 ? (
          <div className="card empty-state">
            <span className="empty-icon">⚡</span>
            <h2 className="empty-title">Create your first agent</h2>
            <p className="empty-desc">
              Agents are AI workers that can research, decide, and take action on your behalf.
              Give them a role, a goal, and a set of guardrails.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-lg" onClick={() => setShowCreate(true)} disabled={hasLlmProvider === false}>
                {hasLlmProvider === false ? 'Configure LLM first' : '+ Create your first agent'}
              </button>
              {hasLlmProvider === false && (
                <Link href="/dashboard/settings" className="btn btn-secondary btn-lg" style={{ textDecoration: 'none' }}>Go to Settings</Link>
              )}
            </div>
            <div style={{ marginTop: 32, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap' }}>
              <span>💡 Try starting with a &quot;Research&quot; archetype</span>
              <span>·</span>
              <span>🔒 Keep autonomy at &quot;SUPERVISED&quot; for first runs</span>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {agents.map(agent => (
              <div key={agent.id} className="card card-hover" style={{ padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '100%' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <div style={{
                      width: 38, height: 38, borderRadius: 10,
                      background: 'var(--green-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 18, color: 'var(--green-dark)', border: '1px solid var(--green-border)'
                    }}>⚡</div>
                    <span className={`badge badge-${agent.status.toLowerCase()}`}>{agent.status}</span>
                  </div>
                  <h3 style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{agent.name}</h3>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
                    {agent.description || 'No description provided'}
                  </p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
                    <span className="tag" data-tooltip={`Provider: ${PROVIDER_LABELS[agent.llm_provider] || agent.llm_provider}`}>
                      {(PROVIDER_LABELS[agent.llm_provider]?.replace(/ \(.*\)$/, '') || agent.llm_provider)} · {agent.llm_model}
                    </span>
                    <span className="tag" style={{ textTransform: 'capitalize' }}>{agent.autonomy_level.toLowerCase()}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Link href={`/dashboard/agents/${agent.id}`} className="btn btn-secondary btn-sm" style={{ flex: 1, textDecoration: 'none' }}>Configure</Link>
                  {agent.status === 'DRAFT' && (
                    <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => activate(agent.id)}>Activate</button>
                  )}
                  {agent.status === 'ACTIVE' && (
                    <Link href={`/dashboard/agents/${agent.id}`} className="btn btn-primary btn-sm" style={{ flex: 1, textDecoration: 'none' }}>Run Task</Link>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => duplicate(agent.id)} title="Duplicate agent" style={{ padding: '0 10px' }}>⧉</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <h2 className="modal-title">Create New Agent</h2>
              <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <form onSubmit={createAgent}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="form-group">
                  <label className="form-label">Agent Name *</label>
                  <input className="input" placeholder="e.g. Contract Compliance Officer" value={form.name} onChange={set('name')} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Description</label>
                  <input className="input" placeholder="What is this worker's responsibility?" value={form.description} onChange={set('description')} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">Archetype</label>
                    <select className="select" value={form.archetype} onChange={set('archetype')}>
                      <option value="">Custom</option>
                      {ARCHETYPES.map(a => <option key={a} value={a.toLowerCase()}>{a}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Autonomy Level</label>
                    <select className="select" value={form.autonomyLevel} onChange={set('autonomyLevel')}>
                      <option value="SUPERVISED">Supervised</option>
                      <option value="SEMI_AUTO">Semi-Auto</option>
                      <option value="AUTONOMOUS">Autonomous</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">LLM Provider &amp; Model</label>
                  {Object.keys(llmProviders).length === 0 ? (
                    <div style={{ padding: 12, border: '1px dashed var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
                      No LLM providers configured yet. <Link href="/dashboard/settings" style={{ color: 'var(--green)', fontWeight: 600 }}>Set one up in Settings →</Link>
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <select
                        className="select"
                        value={form.llmProvider}
                        onChange={e => {
                          const p = e.target.value
                          const suggested = llmProviders[p]?.model || ''
                          setForm(f => ({ ...f, llmProvider: p, llmModel: suggested }))
                        }}
                      >
                        {Object.keys(llmProviders).map(pid => (
                          <option key={pid} value={pid}>{PROVIDER_LABELS[pid] || pid}</option>
                        ))}
                      </select>
                      {LOCAL_PROVIDERS.has(form.llmProvider) ? (
                        <input
                          className="input"
                          value={form.llmModel}
                          onChange={set('llmModel')}
                          placeholder="Model name (e.g. llama3.2)"
                          required
                        />
                      ) : (
                        <input
                          className="input"
                          value={form.llmModel}
                          onChange={set('llmModel')}
                          placeholder="Model name"
                          required
                        />
                      )}
                    </div>
                  )}
                  <p className="form-hint" style={{ marginTop: 6 }}>
                    Only providers you&apos;ve configured are listed. Each agent can use a different provider and model.
                  </p>
                </div>
                <div className="form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4 }}>
                    <label className="form-label" style={{ marginBottom: 0 }}>System Instructions / Prompt</label>
                    <select 
                      className="select" 
                      style={{ width: 'auto', padding: '2px 8px', fontSize: 11, height: 24, minHeight: 24, borderRadius: 4 }}
                      onChange={(e) => {
                        if (e.target.value) setForm(f => ({ ...f, systemPrompt: e.target.value }));
                        e.target.value = "";
                      }}
                    >
                      <option value="">Load template...</option>
                      {PROMPT_TEMPLATES.map(t => (
                        <option key={t.label} value={t.prompt}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <textarea className="input" rows={6} placeholder="Describe rules, behaviors, and standard operating procedures for the agent..." value={form.systemPrompt} onChange={set('systemPrompt')} style={{ resize: 'vertical' }} />
                </div>
                {error && <div className="alert alert-error">{error}</div>}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Creating...' : 'Create Agent'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  )
}
