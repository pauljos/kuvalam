'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import Link from 'next/link'
import { FeedbackModal } from '@/components/FeedbackModal'
import { Breadcrumbs } from '@/components/Breadcrumbs'

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
              <div style={{ display: 'flex', gap: 12 }}>
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
    </div>
  )
}
