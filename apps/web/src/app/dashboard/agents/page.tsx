'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import Link from 'next/link'
import { useConfirm } from '@/components/ConfirmModal'

const ARCHETYPES = ['Planner', 'Research', 'Compliance', 'Document', 'Communication', 'Analytics', 'Coordinator']

const PROMPT_TEMPLATES = [
  { label: 'Data Analyst', name: 'Data Analyst', description: 'Analyzes provided datasets, computes key metrics, and generates summary reports.', archetype: 'analytics', prompt: 'You are an expert Data Analyst agent. Your goal is to analyze provided datasets, compute key metrics, identify trends, and generate comprehensive summary reports.\n\nRULES:\n1. Always verify data formatting before processing.\n2. Summarize key findings in clear markdown tables.\n3. Do not hallucinate data.' },
  { label: 'Software Engineer', name: 'Software Engineer', description: 'Autonomous software engineering agent that writes clean, maintainable code.', archetype: 'coordinator', prompt: 'You are an autonomous Software Engineering agent. Your role is to write clean, maintainable, and efficient code.\n\nRULES:\n1. Plan your architecture before writing code.\n2. Always include basic test coverage for logic.\n3. Ensure code conforms to modern linting standards.' },
  { label: 'Research Assistant', name: 'Research Assistant', description: 'Gathers information, synthesizes long documents, and provides cited summaries.', archetype: 'research', prompt: 'You are a meticulous Research Assistant. Your role is to gather information, synthesize long documents, and provide accurate, cited summaries.\n\nRULES:\n1. Extract key facts and list them as bullet points.\n2. Do not invent information.\n3. When asked to summarize, maintain the original tone.' },
  { label: 'Customer Support', name: 'Customer Support', description: 'Polite and empathetic agent for resolving user issues efficiently.', archetype: 'communication', prompt: 'You are a polite and empathetic Customer Support agent. Your role is to resolve user issues efficiently while maintaining a professional tone.\n\nRULES:\n1. Always start by acknowledging the user\'s frustration or issue.\n2. Provide step-by-step solutions.\n3. Escalate to a human if the issue cannot be resolved.' },
  { label: 'Analytical Agent', name: 'Analytical Agent', description: 'Advanced analytics agent that identifies complex patterns and performs predictive modeling.', archetype: 'analytics', prompt: 'You are a sophisticated Analytical Agent. Your objective is to dive deep into complex datasets, uncover hidden patterns, perform predictive modeling, and provide actionable business intelligence.\n\nRULES:\n1. Use statistical methods to validate your findings.\n2. Present data visualizations and interpretations clearly.\n3. Highlight anomalies or edge cases in the data.' },
  { label: 'Project Manager', name: 'Project Manager', description: 'Coordinates tasks, tracks project progress, and ensures timely delivery.', archetype: 'planner', prompt: 'You are an organized Project Management agent. Your role is to coordinate tasks, allocate resources, track project milestones, and ensure deliverables are met on time.\n\nRULES:\n1. Break down large goals into actionable tasks.\n2. Monitor progress and flag potential bottlenecks early.\n3. Maintain clear and concise communication with all stakeholders.' },
  { label: 'Compliance Officer', name: 'Compliance Officer', description: 'Ensures documents and processes adhere to regulatory and organizational standards.', archetype: 'compliance', prompt: 'You are a strict Compliance agent. Your role is to review documents, code, or processes to ensure they meet all legal, regulatory, and organizational standards.\n\nRULES:\n1. Cross-reference all claims against official guidelines.\n2. Flag any violations or risky language immediately.\n3. Provide specific suggestions for remediation.' },
  { label: 'Content Strategist', name: 'Content Strategist', description: 'Plans, creates, and optimizes content strategies for maximum engagement.', archetype: 'document', prompt: 'You are a creative Content Strategist agent. Your role is to plan, create, and optimize content for maximum audience engagement and brand consistency.\n\nRULES:\n1. Align all content with the target audience and brand voice.\n2. Optimize for readability and SEO where applicable.\n3. Provide structured outlines before drafting long-form content.' },
  { label: 'Browser Automation Agent', name: 'Data Entry Specialist', description: 'Navigates web pages and performs automated data entry and extraction.', archetype: 'coordinator', prompt: 'You are a Browser Automation Agent. Your role is to navigate to specified URLs, interact with web elements (clicking buttons, filling forms), and perform accurate data entry or extraction.\n\nRULES:\n1. Always verify the page state and selectors before interacting with elements.\n2. Handle timeouts and loading states gracefully.\n3. Ensure all data entered matches the provided source perfectly.' }
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
  const [customModels, setCustomModels] = useState<any[]>([])
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
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
    api.getCustomModels(tenantId).then(c => setCustomModels(c?.customModels || [])).catch(() => {})
  }, [tenantId])

  // Fetch available Ollama models when provider is ollama
  useEffect(() => {
    if (form.llmProvider === 'ollama' && tenantId) {
      api.getOllamaAvailableModels(tenantId).then((res: any) => {
        const models = res?.data?.models || res?.models || []
        setOllamaModels(models.map((m: any) => m.name || m))
      }).catch(() => {})
    }
  }, [form.llmProvider, tenantId])

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

  async function deleteAgent(agentId: string) {
    const agent = agents.find(a => a.id === agentId)
    const ok = await confirm({
      title: `Delete "${agent?.name || 'this agent'}"?`,
      description: 'This action cannot be undone. All task history and skills for this agent will be permanently removed.',
      confirmLabel: 'Delete Agent',
      variant: 'danger'
    })
    if (!ok) return
    try {
      await api.deleteAgent(tenantId, agentId)
      setAgents(a => a.filter(x => x.id !== agentId))
      toast('success', 'Agent deleted', `The agent was successfully removed.`)
    } catch (err: any) { toast('error', 'Delete failed', err.message) }
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
                  <button className="btn btn-secondary btn-sm" onClick={() => deleteAgent(agent.id)} title="Delete agent" style={{ padding: '0 10px', color: 'var(--red)' }}>🗑</button>
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
                <div className="form-group" style={{ marginBottom: 4, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
                  <label className="form-label">Start from a Template (Optional)</label>
                  <select 
                    className="select"
                    onChange={(e) => {
                      const t = PROMPT_TEMPLATES.find(x => x.label === e.target.value);
                      if (t) {
                        setForm(f => ({
                          ...f,
                          name: t.name,
                          description: t.description,
                          archetype: t.archetype,
                          systemPrompt: t.prompt
                        }));
                      }
                      e.target.value = "";
                    }}
                  >
                    <option value="">Select a template to auto-fill...</option>
                    {PROMPT_TEMPLATES.map(t => (
                      <option key={t.label} value={t.label}>{t.label}</option>
                    ))}
                  </select>
                </div>
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
                      {(() => {
                        const completedCustom = customModels.filter(cm => cm.status === 'COMPLETED')
                        const hasOllamaModels = form.llmProvider === 'ollama' && (ollamaModels.length > 0 || completedCustom.length > 0)
                        if (hasOllamaModels) {
                          return (
                            <select className="select" value={form.llmModel} onChange={set('llmModel')} required>
                              <option value="" disabled>Select a model...</option>
                              {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
                              {completedCustom.length > 0 && ollamaModels.length > 0 && <option disabled>── Trained Models ──</option>}
                              {completedCustom.map(cm => (
                                <option key={cm.id} value={cm.ollama_tag || cm.model_name}>{cm.model_name} ✨</option>
                              ))}
                            </select>
                          )
                        }
                        if (LOCAL_PROVIDERS.has(form.llmProvider)) {
                          return <input className="input" placeholder="e.g. llama3.2" value={form.llmModel} onChange={set('llmModel')} required />
                        }
                        return <input className="input" placeholder="Model name" value={form.llmModel} onChange={set('llmModel')} required />
                      })()}
                    </div>
                  )}
                  <p className="form-hint" style={{ marginTop: 6 }}>
                    Only providers you&apos;ve configured are listed. Each agent can use a different provider and model.
                  </p>
                </div>
                <div className="form-group">
                  <label className="form-label">System Instructions / Prompt</label>
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
