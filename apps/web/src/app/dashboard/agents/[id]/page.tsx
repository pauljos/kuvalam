'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import Link from 'next/link'
import { FeedbackModal } from '@/components/FeedbackModal'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import Editor from 'react-simple-code-editor'
import Prism from 'prismjs'
import 'prismjs/components/prism-clike'
import 'prismjs/components/prism-javascript'
import 'prismjs/themes/prism-tomorrow.css'

// ─── Live execution trace types ──────────────────────────────────────────────
type TraceEvent =
  | { type: 'phase'; phase: string; label: string }
  | { type: 'token'; phase: string; token: string }
  | { type: 'tool_call'; tool: string; input: any; actionIdx: number }
  | { type: 'tool_result'; tool: string; success: boolean; output: any; actionIdx: number }
  | { type: 'plan_ready'; plan: string }
  | { type: 'completed'; confidence: number; tokensUsed: number }
  | { type: 'failed'; error: string }

const PHASE_LABELS: Record<string, string> = {
  planning: '🧠 Formulating plan',
  thinking: '⚡ Reasoning',
  synthesising: '✨ Synthesising results',
}

export default function AgentDetailPage() {
  const { id } = useParams()
  const router = useRouter()
  const agentId = id as string
  const { tenantId, toast } = useApp()

  const [agent, setAgent] = useState<any>(null)
  const [kbs, setKbs] = useState<any[]>([])
  const [selectedKBs, setSelectedKBs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [llmProviders, setLlmProviders] = useState<Record<string, { model?: string; baseUrl?: string }>>({})

  // Providers whose model catalogue is user-defined
  const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'localai', 'custom'])
  const PROVIDER_LABELS: Record<string, string> = {
    openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', opencode: 'OpenCode',
    groq: 'Groq', mistral: 'Mistral', ollama: 'Ollama (Local)', lmstudio: 'LM Studio (Local)',
    localai: 'LocalAI (Local)', custom: 'Custom (Local)',
  }

  // Task execution state
  const [goal, setGoal] = useState('')
  const [task, setTask] = useState<any>(null)
  const [running, setRunning] = useState(false)
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([])
  const [streamBuffers, setStreamBuffers] = useState<Record<string, string>>({})
  const [showFeedback, setShowFeedback] = useState(false)
  const [currentPhase, setCurrentPhase] = useState<string>('')

  // Skill Modal State
  const [showSkillModal, setShowSkillModal] = useState(false)
  const [newSkill, setNewSkill] = useState({ type: 'nl', name: '', description: '', instruction: '', code: '', url: '', method: 'GET', headers: '{\n  "Content-Type": "application/json"\n}', bodyTemplate: '' })
  const [testInput, setTestInput] = useState('{}')
  const [testResult, setTestResult] = useState<any>(null)
  const [isTesting, setIsTesting] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const pollRef = useRef<any>(null)
  const traceEndRef = useRef<HTMLDivElement>(null)
  const currentTaskId = useRef<string | null>(null)

  useEffect(() => {
    if (tenantId) {
      Promise.all([
        api.getAgent(tenantId, agentId),
        api.listKBs(tenantId).catch(() => ({ knowledgeBases: [] })),
        api.getSettings(tenantId).catch(() => ({ llm_config: { providers: {} } }))
      ]).then(([a, k, s]) => {
        setAgent(a)
        setKbs(k.knowledgeBases || [])
        setSelectedKBs(a.knowledge_bases || [])
        setLlmProviders(s?.llm_config?.providers || {})
        setLoading(false)
      })
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      wsRef.current?.close()
    }
  }, [agentId, tenantId])

  // Auto-scroll trace to bottom
  useEffect(() => {
    traceEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [traceEvents, streamBuffers])

  // ── WebSocket connection for live streaming ──────────────────────────────
  const connectWS = useCallback((tid: string, taskId: string) => {
    wsRef.current?.close()
    const apiBase = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1')
      .replace('/api/v1', '')
    const wsUrl = `${apiBase.replace(/^http/, 'ws')}/ws/tenants/${tid}/telemetry`

    const ws = new WebSocket(wsUrl) // httpOnly cookie is sent automatically
    wsRef.current = ws

    ws.onmessage = (event) => {
      let msg: any
      try { msg = JSON.parse(event.data) } catch { return }
      const { eventType, payload } = msg
      if (!payload || payload.taskId !== taskId) return

      if (eventType === 'agent.phase') {
        setCurrentPhase(payload.phase)
        setTraceEvents(prev => [...prev, { type: 'phase', phase: payload.phase, label: payload.label }])

      } else if (eventType === 'agent.token') {
        setStreamBuffers(prev => ({
          ...prev,
          [payload.phase]: (prev[payload.phase] || '') + payload.token
        }))

      } else if (eventType === 'agent.plan_ready') {
        setTraceEvents(prev => [...prev, { type: 'plan_ready', plan: payload.plan }])

      } else if (eventType === 'agent.tool_call') {
        setTraceEvents(prev => [...prev, {
          type: 'tool_call', tool: payload.tool, input: payload.input, actionIdx: payload.actionIdx
        }])

      } else if (eventType === 'agent.tool_result') {
        setTraceEvents(prev => [...prev, {
          type: 'tool_result', tool: payload.tool, success: payload.success,
          output: payload.output, actionIdx: payload.actionIdx
        }])

      } else if (eventType === 'agent.task_completed') {
        setTraceEvents(prev => [...prev, {
          type: 'completed', confidence: payload.confidence, tokensUsed: payload.tokensUsed
        }])
        setRunning(false)
        setCurrentPhase('')
        ws.close()
        // Fetch final task state for the result panel
        api.getTask(tid, agentId, taskId).then(setTask).catch(() => {})
        // Prompt user for feedback after brief delay
        setTimeout(() => setShowFeedback(true), 800)

      } else if (eventType === 'agent.task_failed') {
        setTraceEvents(prev => [...prev, { type: 'failed', error: payload.error }])
        setRunning(false)
        setCurrentPhase('')
        ws.close()
      }
    }

    ws.onerror = () => {
      // Fall back to polling if WS fails (e.g. in dev without WS proxy)
      startPolling(tid, taskId)
    }
  }, [agentId])

  function startPolling(tid: string, taskId: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const t = await api.getTask(tid, agentId, taskId)
        setTask(t)
        if (['COMPLETED', 'FAILED'].includes(t.status)) {
          clearInterval(pollRef.current)
          setRunning(false)
          setCurrentPhase('')
          if (t.status === 'COMPLETED') setTimeout(() => setShowFeedback(true), 800)
        }
      } catch {
        clearInterval(pollRef.current)
        setRunning(false)
      }
    }, 1500)
  }

  async function updateAgent(e: any) {
    e.preventDefault()
    try {
      const updated = await api.updateAgent(tenantId, agentId, {
        name: agent.name, description: agent.description, systemPrompt: agent.system_prompt,
        autonomyLevel: agent.autonomy_level, llmProvider: agent.llm_provider,
        llmModel: agent.llm_model, confidenceThreshold: agent.confidence_threshold,
        knowledgeBases: selectedKBs
      })
      setAgent(updated)
      toast('success', 'Settings saved', 'Agent configuration has been updated.')
    } catch (err: any) { toast('error', 'Save failed', err.message) }
  }

  async function activate() {
    try {
      const updated = await api.activateAgent(tenantId, agentId)
      setAgent((a: any) => ({ ...a, status: updated.status }))
      toast('success', 'Agent activated', 'The agent is now live.')
    } catch (err: any) { toast('error', 'Activation failed', err.message) }
  }

  async function saveSkill(e: any) {
    e.preventDefault()
    try {
      const isCode = newSkill.type === 'code'
      const isNL = newSkill.type === 'nl'
      
      let config: any = {}
      if (isNL) {
        config = { instruction: newSkill.instruction }
      } else if (isCode) {
        config = { code: newSkill.code }
      } else {
        let parsedHeaders = {}
        let parsedBody = undefined
        try { parsedHeaders = JSON.parse(newSkill.headers || '{}') } catch { throw new Error('Headers must be valid JSON') }
        try { if (newSkill.bodyTemplate) parsedBody = JSON.parse(newSkill.bodyTemplate) } catch { throw new Error('Body Template must be valid JSON') }
        
        config = {
          url: newSkill.url,
          method: newSkill.method,
          headers: parsedHeaders,
          ...(parsedBody ? { body: parsedBody } : {})
        }
      }

      const skillData = {
        name: newSkill.name,
        description: newSkill.description,
        actionId: isNL ? 'nl_instruction' : (isCode ? 'custom_script' : 'webhook'),
        config
      }
      const added = await api.addSkill(tenantId, agentId, skillData)
      setAgent((a: any) => ({ ...a, skills: [...(a.skills || []), added] }))
      setShowSkillModal(false)
      setNewSkill({ type: 'nl', name: '', description: '', instruction: '', code: '', url: '', method: 'GET', headers: '{\n  "Content-Type": "application/json"\n}', bodyTemplate: '' })
      setTestResult(null)
      toast('success', 'Skill Added', 'Custom skill has been attached to the agent.')
    } catch (err: any) {
      toast('error', 'Failed to add skill', err.message)
    }
  }

  async function testSkill(e: any) {
    e.preventDefault()
    if (newSkill.type === 'api' || newSkill.type === 'nl') {
      toast('info', 'Testing coming soon', 'For now, you can save this skill and test it via the agent chat.')
      return
    }
    
    setIsTesting(true)
    setTestResult(null)
    try {
      let parsedInput = {}
      try { parsedInput = JSON.parse(testInput) } catch { /* ignore */ }
      const res = await api.testSkill(tenantId, agentId, {
        code: newSkill.code,
        input: parsedInput
      })
      setTestResult({ success: true, data: res })
    } catch (err: any) {
      setTestResult({ success: false, error: err.message })
    } finally {
      setIsTesting(false)
    }
  }

  async function startTask(e: any) {
    e.preventDefault()
    if (!goal.trim()) return
    setRunning(true)
    setTask(null)
    setTraceEvents([])
    setStreamBuffers({})
    setCurrentPhase('')
    try {
      const t = await api.dispatchTask(tenantId, agentId, { goal })
      const taskId = t.id || t.taskId
      currentTaskId.current = taskId
      setTask(t)
      connectWS(tenantId, taskId)
    } catch (err: any) {
      toast('error', 'Task failed to start', err.message)
      setRunning(false)
    }
  }

  function cancelTask() {
    setRunning(false)
    setCurrentPhase('')
    if (wsRef.current) wsRef.current.close()
    if (pollRef.current) clearInterval(pollRef.current)
    setTraceEvents(prev => [...prev, { type: 'failed', error: 'Cancelled by user' }])
    toast('info', 'Task Cancelled', 'The execution trace was cancelled locally.')
  }

  if (loading) return <div style={{ padding: 40 }}><div className="skeleton" style={{ height: 400 }} /></div>
  if (!agent) return <div style={{ padding: 40 }}>Agent not found</div>

  return (
    <div className="animate-in">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link href="/dashboard/agents" className="btn btn-secondary btn-icon" style={{ borderRadius: '50%' }} aria-label="Back to agents">←</Link>
          <div>
            <Breadcrumbs items={[
              { label: 'Dashboard', href: '/dashboard' },
              { label: 'Agents', href: '/dashboard/agents' },
              { label: agent.name },
            ]} />
            <h1 className="page-title">{agent.name}</h1>
            <p className="page-sub">Configure agent properties and test autonomous goal execution</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className={`badge badge-${agent.status.toLowerCase()}`}>{agent.status}</span>
          {agent.status === 'DRAFT' && <button className="btn btn-primary btn-sm" onClick={activate}>Activate Agent</button>}
        </div>
      </div>

      <div className="page-body grid-2col" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 24 }}>

        {/* Left Column: Properties */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 16 }}>Worker Configuration</h2>
            <form onSubmit={updateAgent} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="form-label">Worker Name</label>
                <input className="input" value={agent.name} onChange={e => setAgent({ ...agent, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label className="form-label">Worker Description</label>
                <input className="input" value={agent.description || ''} onChange={e => setAgent({ ...agent, description: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">System instructions (Guardrails & Constraints)</label>
                <textarea className="input" rows={6} value={agent.system_prompt || ''} onChange={e => setAgent({ ...agent, system_prompt: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">LLM Provider &amp; Model</label>
                {Object.keys(llmProviders).length === 0 ? (
                  <div style={{ padding: 12, border: '1px dashed var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
                    No LLM providers configured. <Link href="/dashboard/settings" style={{ color: 'var(--green-dark)', fontWeight: 600 }}>Set one up in Settings &rarr;</Link>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <select
                      className="input"
                      value={agent.llm_provider || ''}
                      onChange={e => {
                        const p = e.target.value
                        const suggested = llmProviders[p]?.model || agent.llm_model
                        setAgent({ ...agent, llm_provider: p, llm_model: suggested })
                      }}
                    >
                      {/* Preserve the agent's current provider even if it was removed from settings */}
                      {agent.llm_provider && !llmProviders[agent.llm_provider] && (
                        <option value={agent.llm_provider}>{PROVIDER_LABELS[agent.llm_provider] || agent.llm_provider} (not configured)</option>
                      )}
                      {Object.keys(llmProviders).map(pid => (
                        <option key={pid} value={pid}>{PROVIDER_LABELS[pid] || pid}</option>
                      ))}
                    </select>
                    <input
                      className="input"
                      value={agent.llm_model || ''}
                      onChange={e => setAgent({ ...agent, llm_model: e.target.value })}
                      placeholder={LOCAL_PROVIDERS.has(agent.llm_provider) ? 'e.g. llama3.2' : 'Model name'}
                      required
                    />
                  </div>
                )}
                <p className="form-hint" style={{ marginTop: 6 }}>
                  Each agent can use its own provider and model. Manage providers in <Link href="/dashboard/settings" style={{ color: 'var(--green-dark)' }}>Settings</Link>.
                </p>
              </div>
              <div className="form-group">
                <label className="form-label">Attached Knowledge Bases</label>
                {kbs.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No knowledge bases found. <Link href="/dashboard/knowledge" style={{ color: 'var(--green-dark)' }}>Create one</Link></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                    {kbs.map(kb => {
                      const isSelected = selectedKBs.includes(kb.id)
                      return (
                        <label key={kb.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                          <input type="checkbox" checked={isSelected} onChange={() => {
                            setSelectedKBs(prev => isSelected ? prev.filter(i => i !== kb.id) : [...prev, kb.id])
                          }} style={{ accentColor: 'var(--green)' }} />
                          <strong>{kb.name}</strong> ({kb.document_count || 0} docs)
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
              <button className="btn btn-primary" type="submit" style={{ alignSelf: 'flex-start' }}>Save Configuration</button>
            </form>
          </div>

          {/* Custom Skills Section */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800 }}>Custom Skills</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowSkillModal(true)}>+ Add Skill</button>
            </div>
            {agent.skills?.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 300, overflowY: 'auto', paddingRight: 8 }}>
                {agent.skills.map((s: any) => (
                  <div key={s.id} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.description}</div>
                    {s.action_id === 'nl_instruction' && <div style={{ marginTop: 8, fontSize: 11, background: 'var(--surface)', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace', color: '#a855f7', display: 'inline-block' }}>Natural Language</div>}
                    {s.config?.code && <div style={{ marginTop: 8, fontSize: 11, background: 'var(--surface)', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace', color: 'var(--green-dark)', display: 'inline-block' }}>JS Script</div>}
                    {s.config?.url && <div style={{ marginTop: 8, fontSize: 11, background: 'var(--surface)', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace', color: 'var(--blue)', display: 'inline-block' }}>API Endpoint</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No custom skills attached.</div>
            )}
          </div>
        </div>

        {/* Right Column: Live Execution */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 16 }}>Autonomous Execution</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
              Provide a high-level goal. The agent will plan, retrieve knowledge, call tools, and stream results live.
            </p>

            <form onSubmit={startTask} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
              <textarea className="input" rows={3}
                placeholder="e.g. Audit the Acme lease agreement PDF and flag any non-standard termination clauses."
                value={goal} onChange={e => setGoal(e.target.value)} required
                disabled={agent.status !== 'ACTIVE' || running} />
              
              {/* Suggested Tasks */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>Suggestions:</span>
                {agent.name.toLowerCase().includes('malayalam') && (
                  <button type="button" className="btn btn-secondary btn-sm" style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => setGoal("Generate a Malayalam technology newsletter with 3 recent news stories.")}>
                    Generate Newsletter
                  </button>
                )}
                {agent.name.toLowerCase().includes('kaggle') && (
                  <button type="button" className="btn btn-secondary btn-sm" style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => setGoal("Download the Titanic dataset, train a Random Forest model, and prepare the submission.csv file.")}>
                    Solve Titanic Competition
                  </button>
                )}
                <button type="button" className="btn btn-secondary btn-sm" style={{ padding: '2px 8px', fontSize: 11 }}
                  onClick={() => setGoal(`Execute standard workflow for ${agent.name}`)}>
                  Standard Workflow
                </button>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                <button className="btn btn-primary" type="submit" disabled={agent.status !== 'ACTIVE' || running} style={{ flex: 1 }}>
                  {running ? (
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                      <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                      {currentPhase ? (PHASE_LABELS[currentPhase] || currentPhase) : 'Executing...'}
                    </span>
                  ) : '🚀 Execute Task'}
                </button>
                {running && (
                  <button type="button" className="btn btn-secondary" onClick={cancelTask} style={{ color: 'var(--red)' }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>

            {agent.status !== 'ACTIVE' && (
              <div className="alert alert-warning">⚠ You must Activate this Agent before sending it goals.</div>
            )}

            {/* Live streaming trace */}
            {(traceEvents.length > 0 || running) && (
              <div style={{ marginTop: 8 }} className="animate-in">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>Live Execution Trace</span>
                  {task?.status && (
                    <span className={`badge badge-${task.status.toLowerCase()}`}>{task.status}</span>
                  )}
                </div>

                <div style={{
                  background: '#0f1117', borderRadius: 10, padding: '14px 16px',
                  fontFamily: 'monospace', fontSize: 12.5, color: '#e2e8f0',
                  maxHeight: 480, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10
                }}>
                  {traceEvents.map((ev, i) => {
                    if (ev.type === 'phase') return (
                      <div key={i} style={{ color: '#60a5fa', fontWeight: 700, borderTop: i > 0 ? '1px solid #1e293b' : 'none', paddingTop: i > 0 ? 8 : 0 }}>
                        ▶ {ev.label}
                      </div>
                    )
                    if (ev.type === 'plan_ready') return (
                      <div key={i} style={{ color: '#a3e635', whiteSpace: 'pre-wrap', background: '#1a2332', borderRadius: 6, padding: '8px 10px' }}>
                        <div style={{ color: '#64748b', fontSize: 10, marginBottom: 4, textTransform: 'uppercase' }}>Plan</div>
                        {ev.plan}
                        {streamBuffers['planning'] && (
                          <span style={{ color: '#94a3b8' }}>{streamBuffers['planning']}</span>
                        )}
                      </div>
                    )
                    if (ev.type === 'tool_call') return (
                      <div key={i} style={{ borderLeft: '3px solid #f59e0b', paddingLeft: 10 }}>
                        <span style={{ color: '#f59e0b', fontWeight: 700 }}>⚙ {ev.tool}</span>
                        <pre style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 11 }}>{JSON.stringify(ev.input, null, 2)}</pre>
                      </div>
                    )
                    if (ev.type === 'tool_result') return (
                      <div key={i} style={{ borderLeft: `3px solid ${ev.success ? '#22c55e' : '#ef4444'}`, paddingLeft: 10 }}>
                        <span style={{ color: ev.success ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                          {ev.success ? '✓' : '✗'} {ev.tool}
                        </span>
                        <pre style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 11, maxHeight: 80, overflowY: 'auto' }}>
                          {JSON.stringify(ev.output, null, 2)}
                        </pre>
                      </div>
                    )
                    if (ev.type === 'completed') return (
                      <div key={i} style={{ borderTop: '1px solid #1e293b', paddingTop: 10, color: '#22c55e', fontWeight: 700 }}>
                        ✓ Task completed · confidence {Math.round((ev.confidence || 0) * 100)}% · {ev.tokensUsed?.toLocaleString()} tokens
                      </div>
                    )
                    if (ev.type === 'failed') return (
                      <div key={i} style={{ borderTop: '1px solid #1e293b', paddingTop: 10, color: '#ef4444', fontWeight: 700 }}>
                        ✗ Task failed: {ev.error}
                      </div>
                    )
                    return null
                  })}

                  {/* Live streaming buffer — shows tokens as they stream in */}
                  {running && currentPhase && !['plan_ready'].includes(currentPhase) && streamBuffers[currentPhase] && (
                    <div style={{ color: '#94a3b8', whiteSpace: 'pre-wrap', background: '#1a2332', borderRadius: 6, padding: '8px 10px' }}>
                      <div style={{ color: '#64748b', fontSize: 10, marginBottom: 4, textTransform: 'uppercase' }}>{PHASE_LABELS[currentPhase] || currentPhase}</div>
                      {streamBuffers[currentPhase]}
                      <span style={{ animation: 'blink 1s infinite', display: 'inline-block', width: 7, height: 13, background: '#60a5fa', marginLeft: 2, verticalAlign: 'text-bottom' }} />
                    </div>
                  )}

                  {/* Synthesised result */}
                  {task?.result && (
                    <div style={{ borderTop: '2px solid #22c55e', paddingTop: 12, marginTop: 4 }}>
                      <div style={{ color: '#22c55e', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>Synthesised Result</div>
                      <div style={{ color: '#e2e8f0', whiteSpace: 'pre-wrap', lineHeight: 1.6, fontFamily: 'inherit', fontSize: 13 }}>
                        {typeof task.result === 'object' ? (task.result.output || task.result.summary || JSON.stringify(task.result)) : task.result}
                      </div>
                    </div>
                  )}

                  <div ref={traceEndRef} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>

      <FeedbackModal
        open={showFeedback}
        onClose={() => setShowFeedback(false)}
        agentId={agentId}
        title="How did the agent do?"
        subtitle={`Rate the response for "${task?.goal?.slice(0, 60) || 'this task'}"`}
      />

      {showSkillModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ width: 800, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>Add Custom Skill</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24 }}>
              Define a new capability for your agent using plain English, an API endpoint, or custom Node.js code.
            </p>

            <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
              <button 
                type="button"
                className={`btn ${newSkill.type === 'nl' ? 'btn-primary' : 'btn-secondary'}`} 
                onClick={() => setNewSkill({ ...newSkill, type: 'nl' })}
              >
                Natural Language
              </button>
              <button 
                type="button"
                className={`btn ${newSkill.type === 'api' ? 'btn-primary' : 'btn-secondary'}`} 
                onClick={() => setNewSkill({ ...newSkill, type: 'api' })}
              >
                API Endpoint
              </button>
              <button 
                type="button"
                className={`btn ${newSkill.type === 'code' ? 'btn-primary' : 'btn-secondary'}`} 
                onClick={() => setNewSkill({ ...newSkill, type: 'code' })}
              >
                Advanced Script
              </button>
            </div>

            <form onSubmit={saveSkill} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div className="form-group">
                  <label className="form-label">Skill Name (No spaces, e.g. search_crm)</label>
                  <input className="input" value={newSkill.name} onChange={e => setNewSkill({ ...newSkill, name: e.target.value.replace(/\s+/g, '_') })} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Description (Tell the AI *when* to use this)</label>
                  <input className="input" value={newSkill.description} onChange={e => setNewSkill({ ...newSkill, description: e.target.value })} required />
                </div>
              </div>
              
              {newSkill.type === 'nl' ? (
                <div className="form-group">
                  <label className="form-label">Instructions (Plain English)</label>
                  <textarea 
                    className="input" 
                    rows={6} 
                    value={newSkill.instruction} 
                    onChange={e => setNewSkill({ ...newSkill, instruction: e.target.value })} 
                    placeholder="Describe exactly what the agent should do when using this skill. e.g. 'To generate a report, first fetch the sales data, then format it as a markdown table...'" 
                    required={newSkill.type === 'nl'}
                  />
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                    When the agent uses this skill, it will read these instructions and spawn a specialized sub-agent to execute them securely.
                  </p>
                </div>
              ) : newSkill.type === 'api' ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 16 }}>
                    <div className="form-group">
                      <label className="form-label">Method</label>
                      <select className="input" value={newSkill.method} onChange={e => setNewSkill({ ...newSkill, method: e.target.value })}>
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">API URL</label>
                      <input className="input" value={newSkill.url} onChange={e => setNewSkill({ ...newSkill, url: e.target.value })} placeholder="https://api.example.com/v1/data" required={newSkill.type === 'api'} />
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>You can use `{"{{input.parameter}}"}` to map AI arguments into the URL.</p>
                    </div>
                  </div>
                  
                  <div className="form-group">
                    <label className="form-label">Headers (JSON format)</label>
                    <textarea className="input" rows={3} style={{ fontFamily: 'monospace' }} value={newSkill.headers} onChange={e => setNewSkill({ ...newSkill, headers: e.target.value })} />
                  </div>
                  
                  {['POST', 'PUT', 'PATCH'].includes(newSkill.method) && (
                    <div className="form-group">
                      <label className="form-label">Body Template (JSON format)</label>
                      <textarea className="input" rows={4} style={{ fontFamily: 'monospace' }} value={newSkill.bodyTemplate} onChange={e => setNewSkill({ ...newSkill, bodyTemplate: e.target.value })} placeholder={'{\n  "query": "{{input.query}}"\n}'} />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label">Node.js Sandbox Script</label>
                    <div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid #1e293b' }}>
                      <Editor
                        value={newSkill.code}
                        onValueChange={code => setNewSkill({ ...newSkill, code })}
                        highlight={code => Prism.highlight(code, Prism.languages.javascript, 'javascript')}
                        padding={16}
                        style={{
                          fontFamily: '"Fira Code", "JetBrains Mono", monospace',
                          fontSize: 13,
                          backgroundColor: '#1d1f21',
                          color: '#c5c8c6',
                          minHeight: 200
                        }}
                        textareaClassName="code-editor-textarea"
                      />
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                      Example: <code>{"const res = await fetch(`https://api.example.com/data?q=${input.query}`); return await res.json();"}</code>
                    </p>
                  </div>

                  {/* Test Panel */}
                  <div style={{ background: 'var(--surface)', padding: 16, borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                      <div className="form-group" style={{ flex: 1, margin: 0 }}>
                        <label className="form-label" style={{ fontSize: 12 }}>Test Input (JSON)</label>
                        <textarea 
                          className="input" 
                          rows={3} 
                          style={{ fontFamily: 'monospace', fontSize: 12 }}
                          value={testInput} 
                          onChange={e => setTestInput(e.target.value)} 
                        />
                      </div>
                      <button type="button" className="btn btn-secondary" onClick={testSkill} disabled={isTesting || !newSkill.code} style={{ marginTop: 24 }}>
                        {isTesting ? 'Running...' : '▶ Test Skill'}
                      </button>
                    </div>
                    
                    {testResult && (
                      <div style={{ marginTop: 12, padding: 12, borderRadius: 6, background: '#0f1117', borderLeft: `3px solid ${testResult.success ? '#22c55e' : '#ef4444'}` }}>
                        <div style={{ color: testResult.success ? '#22c55e' : '#ef4444', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>
                          {testResult.success ? 'Success' : 'Error'}
                        </div>
                        <pre style={{ margin: 0, color: '#e2e8f0', fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 150, overflowY: 'auto' }}>
                          {testResult.success ? JSON.stringify(testResult.data, null, 2) : testResult.error}
                        </pre>
                      </div>
                    )}
                  </div>
                </>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" onClick={() => {
                  setShowSkillModal(false); setTestResult(null)
                }}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={!newSkill.name || (newSkill.type === 'code' ? !newSkill.code : newSkill.type === 'api' ? !newSkill.url : !newSkill.instruction)}>Save Skill</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
