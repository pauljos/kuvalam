'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api, API_BASE } from '@/lib/api'
import { useApp } from '@/lib/context'
import Link from 'next/link'
import { useConfirm } from '@/components/ConfirmModal'
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
  | { type: 'completed'; confidence: number; tokensUsed: number; durationMs?: number }
  | { type: 'failed'; error: string }

const PHASE_LABELS: Record<string, string> = {
  planning: '🧠 Formulating plan',
  thinking: '⚡ Reasoning',
  synthesising: '✨ Synthesising results',
  awaiting_approval: '⏳ Awaiting human approval',
  resuming: '🔄 Resuming after approval',
  rejected: '✕ Action rejected',
}

export default function AgentDetailPage() {
  const { id } = useParams()
  const router = useRouter()
  const agentId = id as string
  const { tenantId, toast } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()

  const [agent, setAgent] = useState<any>(null)
  const [kbs, setKbs] = useState<any[]>([])
  const [selectedKBs, setSelectedKBs] = useState<string[]>([])
  const [graphs, setGraphs] = useState<any[]>([])
  const [selectedGraphs, setSelectedGraphs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [llmProviders, setLlmProviders] = useState<Record<string, { model?: string; baseUrl?: string }>>({})
  const [customModels, setCustomModels] = useState<any[]>([])
  const [ollamaModels, setOllamaModels] = useState<string[]>([])

  // Providers whose model catalogue is user-defined
  const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'localai', 'custom'])
  const PROVIDER_LABELS: Record<string, string> = {
    openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', opencode: 'OpenCode',
    groq: 'Groq', mistral: 'Mistral', ollama: 'Ollama (Local)', lmstudio: 'LM Studio (Local)',
    localai: 'LocalAI (Local)', custom: 'Custom (Local)',
  }

  // Task execution state
  const [goal, setGoal] = useState('')
  const [autoLoadedGoal, setAutoLoadedGoal] = useState(false) // true if goal was pre-filled from past execution
  const [task, setTask] = useState<any>(null)
  const [running, setRunning] = useState(false)
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([])
  const [streamBuffers, setStreamBuffers] = useState<Record<string, string>>({})
  const [showFeedback, setShowFeedback] = useState(false)
  const [currentPhase, setCurrentPhase] = useState<string>('')
  const [pastTasks, setPastTasks] = useState<any[]>([])
  const [showAllTasks, setShowAllTasks] = useState(false)
  const [deleteState, setDeleteState] = useState(0)
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null)

  // Skill Modal State
  const [showSkillModal, setShowSkillModal] = useState(false)
  // Worker Configuration display state (collapsible sections)
  const [showSystemPrompt, setShowSystemPrompt] = useState(true)
  const [showKnowledge, setShowKnowledge] = useState(false)
  const [newSkill, setNewSkill] = useState({ type: 'nl', name: '', description: '', instruction: '', code: '', url: '', method: 'GET', headers: '{\n  "Content-Type": "application/json"\n}', bodyTemplate: '', language: 'javascript' })
  const [testInput, setTestInput] = useState('{}')
  const [testResult, setTestResult] = useState<any>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [skillPrompt, setSkillPrompt] = useState('')
  const [generatingSkill, setGeneratingSkill] = useState(false)

  // Tool Capabilities State
  const [scopes, setScopes] = useState<any[]>([])
  const [connectors, setConnectors] = useState<any[]>([])
  const [mcpServers, setMcpServers] = useState<any[]>([])
  const [scopeDraft, setScopeDraft] = useState<Record<string, { scopeType: string; accessLevel: string }>>({})
  const [loadingScopes, setLoadingScopes] = useState(false)
  const [showAllConnectors, setShowAllConnectors] = useState(false)
  const [showAllMcp, setShowAllMcp] = useState(false)

  // Browser agent connectivity test
  const [browserStatus, setBrowserStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')

  // System prompt preview
  const [promptPreview, setPromptPreview] = useState<any>(null)
  const [loadingPromptPreview, setLoadingPromptPreview] = useState(false)
  const [promptMode, setPromptMode] = useState<'full' | 'local' | 'summarised'>('full')
  const [compressedPreview, setCompressedPreview] = useState<any>(null)
  const [localPreview, setLocalPreview] = useState<any>(null)
  const [loadingCompressed, setLoadingCompressed] = useState(false)
  const [loadingLocal, setLoadingLocal] = useState(false)
  const [savingPromptMode, setSavingPromptMode] = useState(false)

  // AI Prompt & Guardrail Refiner
  const [refineScenario, setRefineScenario] = useState('')
  const [refiningPrompt, setRefiningPrompt] = useState(false)
  const [refineResult, setRefineResult] = useState<any>(null)
  const [applyingRefine, setApplyingRefine] = useState(false)
  const [cloneModalOpen, setCloneModalOpen] = useState(false)
  const [cloneName, setCloneName] = useState('')
  const [cloningAgent, setCloningAgent] = useState(false)

  // Agent Memory (long-term entity + episodic)
  const [agentMemory, setAgentMemory] = useState<any>({ entityMemory: [], episodicMemory: [] })
  const [loadingMemory, setLoadingMemory] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null)

  const BUILTIN_TOOLS = [
    { id: 'http_request', name: 'HTTP Request', description: 'Make HTTP requests to any URL' },
    { id: 'http_download', name: 'HTTP Download', description: 'Download a file from a URL (max 5MB)' },
    { id: 'file_search', name: 'File Search', description: 'Search file contents on the filesystem via grep/rg' },
    { id: 'docker_run', name: 'Docker Run', description: 'Run commands in a Docker container' },
    { id: 'ssh_exec', name: 'SSH Exec', description: 'Execute commands on remote machines via SSH' },
    { id: 'a2a_call', name: 'A2A Call', description: 'Delegate tasks to external agents via A2A' },
    { id: 'delegate_task', name: 'Delegate Task', description: 'Delegate subtasks to other internal agents' },
    { id: 'browser_use', name: 'Browser Use', description: 'Control a real web browser' },
    { id: 'publish_dashboard_report', name: 'Publish Report', description: 'Publish dynamic HTML reports to dashboard' },
    // ML Service tools — optional, require ML_SERVICE_URL on the API server
    { id: 'ml_transcribe', name: 'ML: Transcribe Audio', description: 'Speech-to-text via Whisper (requires ML service)' },
    { id: 'ml_sentiment',  name: 'ML: Sentiment Analysis', description: 'FinBERT financial/general sentiment (requires ML service)' },
    { id: 'ml_entities',   name: 'ML: Entity Extraction', description: 'BERT named entity recognition (requires ML service)' },
    { id: 'ml_classify',   name: 'ML: Zero-Shot Classify', description: 'BART zero-shot text classification (requires ML service)' },
    { id: 'ml_ocr',           name: 'ML: Image OCR',            description: 'TrOCR image text extraction (requires ML service)' },
    { id: 'ml_parse_document', name: 'ML: Parse Document',        description: 'Donut invoice/receipt/form structured extraction (requires ML service)' },
    { id: 'ml_forecast',       name: 'ML: Time-Series Forecast',  description: 'Prophet demand/sales forecasting with confidence intervals (requires ML service)' },
    { id: 'ml_anomaly_detect', name: 'ML: Anomaly Detection',     description: 'Isolation Forest outlier detection on tabular data (requires ML service)' },
    { id: 'ml_image_search',   name: 'ML: Image-Text Similarity', description: 'CLIP image-text matching and visual search (requires ML service)' },
  ]

  const wsRef = useRef<WebSocket | null>(null)
  const pollRef = useRef<any>(null)
  const traceEndRef = useRef<HTMLDivElement>(null)
  const traceContainerRef = useRef<HTMLDivElement>(null)
  const currentTaskId = useRef<string | null>(null)
  const wsRetryCount = useRef<number>(0)
  const wsRetryTimeout = useRef<any>(null)
  const cancellingRef = useRef<boolean>(false) // prevents WS reconnect when user hits Stop
  const userScrolledUpRef = useRef<boolean>(false) // user manually scrolled away from bottom → pause auto-scroll

  useEffect(() => {
    if (tenantId) {
      Promise.all([
        api.getAgent(tenantId, agentId),
        api.listKBs(tenantId).catch(() => ({ knowledgeBases: [] })),
        api.listKnowledgeGraphs(tenantId).catch(() => ({ knowledgeGraphs: [] })),
        api.getSettings(tenantId).catch(() => ({ llm_config: { providers: {} } })),
        api.getCustomModels(tenantId).catch(() => ({ customModels: [] }))
      ]).then(([a, k, g, s, c]) => {
        setAgent(a)
        setKbs(k.knowledgeBases || [])
        setSelectedKBs(a.knowledge_base_ids || [])
        setGraphs(g.knowledgeGraphs || [])
        setSelectedGraphs(a.knowledge_graph_ids || [])
        setLlmProviders(s?.llm_config?.providers || {})
        setCustomModels(c?.customModels || [])
        setLoading(false)
      })
      api.listTasks(tenantId, agentId).then((res: any) => {
        const tasks = res?.tasks || res || []
        setPastTasks(tasks)
        // Check for pre-selected task from dashboard execution log
        let preselectedId: string | null = null
        try { preselectedId = sessionStorage.getItem(`task-select-${agentId}`) } catch {}
        if (preselectedId) {
          try { sessionStorage.removeItem(`task-select-${agentId}`) } catch {}
          const preselected = tasks.find((t: any) => t.id === preselectedId)
          if (preselected) {
            setTask(preselected)
            setGoal(preselected.goal || '')
            setAutoLoadedGoal(true)
            return
          }
        }
        // Auto-load the last SUCCESSFUL/COMPLETED/STOPPED task's prompt
        // so users can quickly re-run with the same prompt (one click).
        const lastSuccessful = tasks.find((t: any) =>
          ['COMPLETED','STOPPED','SUCCESSFUL'].includes(t.status?.toUpperCase?.() || '')
        )
        if (lastSuccessful?.goal) {
          setGoal(lastSuccessful.goal)
          setAutoLoadedGoal(true)
        }
      }).catch(() => {})

      // Fetch scopes, connectors, and MCPs for the Capabilities UI
      setLoadingScopes(true)
      Promise.all([
        api.listScopes(tenantId, agentId).catch(() => []),
        api.listConnectors(tenantId).catch(() => ({ data: { connectors: [] } })),
        api.listMcpServers(tenantId).catch(() => []),
      ]).then(([scopesRes, connRes, mcpRes]) => {
        const scopesList = Array.isArray(scopesRes) ? scopesRes : scopesRes?.scopes || []
        setScopes(scopesList)
        setConnectors(connRes?.data?.connectors || connRes?.connectors || [])
        setMcpServers(Array.isArray(mcpRes) ? mcpRes : mcpRes?.servers || [])
        // Build draft from existing scopes
        const draft: Record<string, { scopeType: string; accessLevel: string }> = {}
        for (const s of scopesList) {
          const key = s.scope_type === 'connector' ? `connector:${s.connector_id}`
            : s.scope_type === 'mcp_server' ? `mcp:${s.mcp_server_id}`
            : s.scope_type === 'group' ? `group:${s.group_name}`
            : `builtin:${s.builtin_name}`
          draft[key] = { scopeType: s.scope_type, accessLevel: s.access_level }
        }
        setScopeDraft(draft)
        setLoadingScopes(false)
      }).catch(() => setLoadingScopes(false))
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      wsRef.current?.close()
    }
  }, [agentId, tenantId])

  // Fetch available Ollama models when the agent's provider is ollama
  useEffect(() => {
    if (agent?.llm_provider === 'ollama' && tenantId) {
      api.getOllamaAvailableModels(tenantId).then((res: any) => {
        const models = res?.data?.models || res?.models || []
        setOllamaModels(models.map((m: any) => m.name || m))
      }).catch(() => {})
    }
  }, [agent?.llm_provider, tenantId])

  // Load agent memory (long-term entity + episodic) — refreshed whenever the
  // page mounts or the agent changes.
  const loadAgentMemory = useCallback(async () => {
    if (!tenantId) return
    setLoadingMemory(true)
    try {
      const res = await api.getAgentMemory(tenantId, agentId)
      const d = res?.data || res || {}
      setAgentMemory({ entityMemory: d.entityMemory || [], episodicMemory: d.episodicMemory || [] })
    } catch {
      setAgentMemory({ entityMemory: [], episodicMemory: [] })
    } finally {
      setLoadingMemory(false)
    }
  }, [tenantId, agentId])

  useEffect(() => { loadAgentMemory() }, [loadAgentMemory])

  // Auto-scroll trace to bottom — only if user hasn't manually scrolled up.
  // When the user scrolls away from the bottom, auto-scroll is paused so they
  // can freely review past output. It resumes when they scroll back to bottom.
  useEffect(() => {
    const container = traceContainerRef.current
    if (!container || userScrolledUpRef.current) return
    const threshold = 100 // px from bottom: still auto-scroll
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold
    if (nearBottom) {
      traceEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [traceEvents, streamBuffers])

  // ── WebSocket connection for live streaming ──────────────────────────────
  const connectWS = useCallback((tid: string, taskId: string) => {
    wsRef.current?.close()
    
    // Reset retry count on successful connection
    wsRetryCount.current = 0
    
    // Build WebSocket URL safely.  Fetch a short-lived token because
    // the httpOnly cookie is not sent cross-origin by WebSocket constructors.
    // useCallback cannot be async, so we chain .then() instead of await.
    api.fetchWSToken().then(token => {
      const url = new URL(API_BASE)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.pathname = `/ws/tenants/${tid}/telemetry`
      url.searchParams.set('token', token)
      const wsUrl = url.toString()
      const ws = new WebSocket(wsUrl)
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
          type: 'completed', confidence: payload.confidence, tokensUsed: payload.tokensUsed, durationMs: payload.durationMs
        }])
        setRunning(false)
        setCurrentPhase('')
        ws.close()
        // Fetch final task state for the result panel
        api.getTask(tid, agentId, taskId).then(t => {
          setTask(t)
          setPastTasks(prev => {
            const exists = prev.some(p => p.id === t.id)
            return exists ? prev : [t, ...prev]
          })
        }).catch(() => {})
        // Prompt user for feedback after brief delay
        setTimeout(() => setShowFeedback(true), 800)

      } else if (eventType === 'agent.task_failed') {
        setTraceEvents(prev => [...prev, { type: 'failed', error: payload.error }])
        setRunning(false)
        setCurrentPhase('')
        ws.close()
        // Also add the failed task to past executions
        api.getTask(tid, agentId, taskId).then(t => {
          setTask(t)
          setPastTasks(prev => {
            const exists = prev.some(p => p.id === t.id)
            return exists ? prev : [t, ...prev]
          })
        }).catch(() => {})

      } else if (eventType === 'agent.approval_required') {
        // Task is paused waiting for human approval
        setCurrentPhase('awaiting_approval')
        setTraceEvents(prev => [...prev, {
          type: 'phase', phase: 'awaiting_approval',
          label: `⏳ Waiting for approval — tool "${payload.tool}" needs human review`
        }])

      } else if (eventType === 'agent.approval_granted') {
        setCurrentPhase('resuming')
        setTraceEvents(prev => [...prev, {
          type: 'phase', phase: 'resuming',
          label: `✅ Tool "${payload.tool}" approved${payload.decisionNote ? ` — "${payload.decisionNote}"` : ''}, resuming execution...`
        }])

      } else if (eventType === 'agent.approval_rejected') {
        setCurrentPhase('rejected')
        setTraceEvents(prev => [...prev, {
          type: 'phase', phase: 'rejected',
          label: `✕ Tool "${payload.tool}" rejected${payload.reason ? ` — "${payload.reason}"` : ''}`
        }])

      } else if (eventType === 'agent.approval_timeout') {
        setCurrentPhase('failed')
        setTraceEvents(prev => [...prev, {
          type: 'phase', phase: 'failed',
          label: `⏰ Approval timeout — no response received in time`
        }])

      } else if (eventType === 'agent.task_resuming') {
        setCurrentPhase('resuming')
        setTraceEvents(prev => [...prev, {
          type: 'phase', phase: 'resuming',
          label: '🔄 Task resuming after approval...'
        }])
      }
    }

    ws.onerror = () => {
      console.warn('[WS] WebSocket error, will attempt reconnection')
    }

    ws.onclose = (event) => {
      console.log('[WS] Connection closed:', event.code, event.reason)
      
      // Don't reconnect if task is done or user cancelled
      if (cancellingRef.current || !running) return
      
      // Exponential backoff reconnection
      const retryDelay = Math.min(1000 * Math.pow(2, wsRetryCount.current), 30000)
      console.log(`[WS] Reconnecting in ${retryDelay}ms (attempt ${wsRetryCount.current + 1})`)
      
      wsRetryTimeout.current = setTimeout(() => {
        wsRetryCount.current++
        connectWS(tid, taskId)
      }, retryDelay)
    }
    }).catch(err => { console.warn('[WS] Failed to fetch WS token:', err) })
  }, [agentId, running])

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
          setPastTasks(prev => {
            const exists = prev.some(p => p.id === t.id)
            return exists ? prev : [t, ...prev]
          })
          if (t.status === 'COMPLETED') setTimeout(() => setShowFeedback(true), 800)
        }
      } catch {
        clearInterval(pollRef.current)
        setRunning(false)
      }
    }, 1500)
  }

  // Backfill trace events from task history if we missed the live websocket
  useEffect(() => {
    if (task && traceEvents.length === 0) {
      const reconstructed: TraceEvent[] = []
      let hasPlan = false
      if (task.plan) {
        // Plan can be stored as { content: '...' } (new format) or { steps: '...' } (old placeholder)
        const planText = typeof task.plan === 'object'
          ? (task.plan.content || task.plan.steps || JSON.stringify(task.plan))
          : task.plan
        reconstructed.push({ type: 'phase', phase: 'planning', label: '🧠 Formulating plan' } as any)
        reconstructed.push({ type: 'plan_ready', plan: planText } as any)
        hasPlan = true
      }
      if (task.actions && Array.isArray(task.actions) && task.actions.length > 0) {
        // Phase transition: thinking/executing
        reconstructed.push({ type: 'phase', phase: 'thinking', label: '⚡ Reasoning & executing tools' } as any)
        task.actions.forEach((act: any) => {
          // Show LLM reasoning if stored in the action (thought/content field)
          if (act.thought || act.content || act.reasoning) {
            const reasoningText = act.thought || act.content || act.reasoning
            reconstructed.push({ type: 'phase', phase: 'thinking', label: `💭 ${String(reasoningText).slice(0, 300)}` } as any)
          }
          reconstructed.push({ type: 'tool_call', phase: 'executing', tool: act.skill, input: act.input } as any)
          // Actions store { output: { success, ... } } — read output directly
          // For runQuery, summarize instead of dumping full rows
          const output = act.output || {}
          const displayOutput = act.skill === 'runQuery' && output.success
            ? { ...output, rows: `[${(output.rows || []).length} rows — ${(output.columns || []).join(', ')}]` }
            : output
          reconstructed.push({ type: 'tool_result', phase: 'executing', tool: act.skill, success: output.success, output: displayOutput } as any)
        })
      }
      // Show the error for FAILED tasks (but NOT cancelled ones — supervisor errors go there)
      if ((task.error || task.status === 'FAILED') && task.status !== 'CANCELLED') {
        reconstructed.push({ type: 'phase', phase: 'failed', label: '✕ Execution failed' } as any)
        reconstructed.push({ type: 'failed', error: task.error || 'Task failed with no error details' } as any)
      }
      // CANCELLED tasks — distinguish supervisor kill from user stop
      if (task.status === 'CANCELLED') {
        const supervisorReason = (task.error || '').includes('[Supervisor]')
          ? (task.error || '').replace(/.*\[Supervisor\]\s*/s, '').trim()
          : ''
        reconstructed.push({
          type: 'phase', phase: 'cancelled',
          label: supervisorReason
            ? `🛑 Task cancelled by supervisor: ${supervisorReason}`
            : '✕ Execution stopped by user'
        } as any)
      }
      // Completed tasks get a synthesising phase
      if (task.status === 'COMPLETED' && !(task.error || task.status === 'FAILED')) {
        reconstructed.push({ type: 'phase', phase: 'synthesising', label: '✨ Synthesising results' } as any)
      }
      if (reconstructed.length > 0) {
        setTraceEvents(reconstructed)
      }
    }
  }, [task, traceEvents.length])

  async function updateAgent(e: any) {
    e.preventDefault()
    try {
      // Sync Knowledge Bases
      const existingKBs = agent.knowledge_base_ids || []
      const kbsToAdd = selectedKBs.filter(id => !existingKBs.includes(id))
      const kbsToRemove = existingKBs.filter((id: string) => !selectedKBs.includes(id))

      // Sync Knowledge Graphs
      const existingGraphs = agent.knowledge_graph_ids || []
      const graphsToAdd = selectedGraphs.filter(id => !existingGraphs.includes(id))
      const graphsToRemove = existingGraphs.filter((id: string) => !selectedGraphs.includes(id))

      await Promise.all([
        ...kbsToAdd.map(id => api.linkKB(tenantId, agentId, id)),
        ...kbsToRemove.map((id: string) => api.unlinkKnowledgeBase(tenantId, agentId, id)),
        ...graphsToAdd.map(id => api.linkKnowledgeGraph(tenantId, agentId, id)),
        ...graphsToRemove.map((id: string) => api.unlinkKnowledgeGraph(tenantId, agentId, id))
      ])

      const updated = await api.updateAgent(tenantId, agentId, {
        name: agent.name, description: agent.description, systemPrompt: agent.system_prompt,
        autonomyLevel: agent.autonomy_level, llmProvider: agent.llm_provider,
        llmModel: agent.llm_model, confidenceThreshold: agent.confidence_threshold,
        archetype: agent.archetype, dataStrategy: agent.data_strategy,
        useMemory: agent.use_memory
      })
      // Fetch the full agent again to get the updated KB list
      const freshAgent = await api.getAgent(tenantId, agentId)
      setAgent(freshAgent.data || freshAgent)
      toast('success', 'Settings saved', 'Agent configuration has been updated.')
    } catch (err: any) { toast('error', 'Save failed', err.message) }
  }

  async function testBrowserAgent() {
    setBrowserStatus('testing')
    try {
      // Call the browser-agent sidecar health endpoint directly
      const res = await fetch('http://localhost:9223/health')
      const data = await res.json()
      setBrowserStatus(data?.browser === 'connected' || data?.status === 'ok' ? 'ok' : 'error')
    } catch {
      setBrowserStatus('error')
    }
    // Reset after 10 seconds
    setTimeout(() => setBrowserStatus('idle'), 10000)
  }

  async function loadPromptPreview() {
    if (!tenantId || !agentId) return
    setLoadingPromptPreview(true)
    try {
      const res = await api.previewAgentPrompt(tenantId, agentId, goal)
      setPromptPreview(res)
    } catch (err: any) {
      toast('error', 'Failed to load prompt preview', err.message)
    } finally {
      setLoadingPromptPreview(false)
    }
  }

  // Teach the agent from a scenario: refine its System Instructions + Goal, then
  // show a preview for the user to review before applying (approve/reject).
  async function refinePrompt(scenario?: string) {
    const sc = (scenario || refineScenario || '').trim()
    if (!sc) return toast('error', 'Enter a scenario first', 'Describe the goal or scenario you want to teach the agent.')
    if (!tenantId || !agentId) return
    setRefiningPrompt(true)
    setRefineResult(null) // clear any previous preview
    try {
      const res = await api.refineAgentPrompt(tenantId, agentId, {
        scenario: sc,
        systemPrompt: agent.system_prompt,
        goal: sc // pass the current goal for refinement too
      })
      const refined = res?.data || res
      if (!refined?.updatedSystemPrompt) throw new Error('No updated prompt returned')

      // Show preview — do NOT auto-save. User must approve.
      setRefineResult(refined)
      if (refined.usedFallback) {
        toast('info', 'Preview ready (fallback)', refined.summary || 'Review the proposed changes below.')
      } else {
        toast('success', 'Preview ready', refined.summary || 'Review the proposed changes, then Approve or Reject.')
      }
    } catch (err: any) {
      toast('error', 'Refine failed', err.message)
    } finally {
      setRefiningPrompt(false)
    }
  }

  // User approves the refined changes → save them.
  async function approveRefine() {
    if (!refineResult || !tenantId || !agentId) return
    setApplyingRefine(true)
    try {
      await api.updateAgent(tenantId, agentId, { systemPrompt: refineResult.updatedSystemPrompt })
      setAgent((a: any) => ({ ...a, system_prompt: refineResult.updatedSystemPrompt }))
      // Copy the refined goal into the execution box for easy re-use
      if (refineResult.refinedGoal) {
        setGoal(refineResult.refinedGoal)
        setAutoLoadedGoal(false)
      }
      toast('success', 'Agent updated & saved', 'System instructions and guardrails applied.')
      setRefineResult(null)
      setRefineScenario('')
    } catch (err: any) {
      toast('error', 'Save failed', err.message)
    } finally {
      setApplyingRefine(false)
    }
  }

  // User rejects the proposed changes.
  function rejectRefine() {
    setRefineResult(null)
    toast('info', 'Changes discarded', 'The agent was not modified.')
  }

  // Open the clone modal — prefill with a suggested name.
  function cloneFromRefine() {
    if (!refineResult || !agent) return
    setCloneName(`${agent.name || 'Agent'} (refined)`)
    setCloneModalOpen(true)
  }

  // Create a new agent cloned from the current one with refined prompt.
  async function confirmCloneAgent() {
    if (!refineResult || !tenantId || !cloneName.trim()) return
    setCloningAgent(true)
    try {
      const body = {
        name: cloneName.trim(),
        description: agent.description || '',
        archetype: agent.archetype || 'generalist',
        systemPrompt: refineResult.updatedSystemPrompt,
        autonomyLevel: agent.autonomy_level || 'SUPERVISED',
      }
      const res = await api.createAgent(tenantId, body)
      const newAgent = res?.data || res
      const newId = newAgent?.id || newAgent?.agent?.id
      toast('success', 'Agent cloned', `New agent "${cloneName.trim()}" created.`)

      // Close modal and clear refine state
      setCloneModalOpen(false)
      setCloneName('')
      setRefineResult(null)
      setRefineScenario('')

      // Navigate to the new agent if we have an ID
      if (newId) {
        router.push(`/dashboard/agents/${newId}`)
      }
    } catch (err: any) {
      toast('error', 'Clone failed', err.message)
    } finally {
      setCloningAgent(false)
    }
  }

  async function handleRemoveSkill(e: any, skillId: string) {
    e.stopPropagation()
    const ok = await confirm({
      title: 'Remove Skill',
      description: 'Are you sure you want to remove this skill?',
      confirmLabel: 'Remove'
    })
    if (!ok) return
    try {
      await api.removeSkill(tenantId, agentId, skillId)
      setAgent((a: any) => ({ ...a, skills: a.skills.filter((s: any) => s.id !== skillId) }))
      toast('success', 'Skill removed')
    } catch (err: any) { toast('error', 'Failed to remove skill', err.message) }
  }

  async function handleDeleteTask(e: any, taskId: string) {
    e.stopPropagation()
    const ok = await confirm({
      title: 'Delete Execution',
      description: 'Are you sure you want to delete this past execution?',
      confirmLabel: 'Delete'
    })
    if (!ok) return
    try {
      await api.deleteTask(tenantId, agentId, taskId)
      setPastTasks(prev => prev.filter(t => t.id !== taskId))
      toast('success', 'Execution history deleted')
    } catch (err: any) { toast('error', 'Failed to delete execution', err.message) }
  }

  async function handleRetryTask(e: any, taskId: string, mode: 'checkpoint' | 'fresh') {
    e.stopPropagation()
    setRetryingTaskId(taskId)
    try {
      const res = await api.retryTask(tenantId, agentId, taskId, mode)
      const retried = res?.task || res
      setPastTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'QUEUED' } : t))
      const tid = retried?.id || taskId
      currentTaskId.current = tid
      setTask(retried)
      setGoal(retried?.goal || '')
      setTraceEvents([])
      setStreamBuffers({})
      setRunning(true)
      setCurrentPhase('')
      connectWS(tenantId, tid)
      toast('info', mode === 'checkpoint' ? 'Resuming from checkpoint' : 'Restarting from scratch', '')
    } catch (err: any) {
      toast('error', 'Retry failed', err.message)
    } finally {
      setRetryingTaskId(null)
    }
  }

  async function handleCancelTask(e: any, taskId: string) {
    e.stopPropagation()
    const ok = await confirm({
      title: 'Stop Execution',
      description: 'Are you sure you want to stop this running execution?',
      confirmLabel: 'Stop'
    })
    if (!ok) return
    try {
      await api.cancelTask(tenantId, agentId, taskId)
      setPastTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'CANCELLED' } : t))
      if (task?.id === taskId) setTask({ ...task, status: 'CANCELLED' })
      toast('success', 'Execution stopped')
    } catch (err: any) { toast('error', 'Failed to stop execution', err.message) }
  }

  async function activate() {
    try {
      const updated = await api.activateAgent(tenantId, agentId)
      setAgent((a: any) => ({ ...a, status: updated.status }))
      toast('success', 'Agent activated', 'The agent is now live.')
    } catch (err: any) { toast('error', 'Activation failed', err.message) }
  }

  async function saveScopes() {
    try {
      // Convert draft to expected API format (camelCase, matching backend addScope)
      const scopesPayload = Object.entries(scopeDraft).map(([key, val]) => {
        const [type, id] = key.split(':')
        const payload: any = { scopeType: val.scopeType, accessLevel: val.accessLevel }
        if (type === 'connector') payload.connectorId = id
        else if (type === 'mcp') payload.mcpServerId = id
        else if (type === 'builtin') payload.builtinName = id
        else if (type === 'group') payload.groupName = id
        return payload
      })
      await api.setScopes(tenantId, agentId, { scopes: scopesPayload })
      // Refresh scopes from server
      const fresh = await api.listScopes(tenantId, agentId)
      const freshList = Array.isArray(fresh) ? fresh : fresh?.scopes || []
      setScopes(freshList)
      toast('success', 'Tool capabilities saved')
    } catch (err: any) {
      toast('error', 'Failed to save capabilities', err.message)
    }
  }

  async function applyArchetypePresets(archetype: string) {
    try {
      const res = await api.getScopePresets(tenantId, agentId)
      // Backend returns { presets: { 'customer-support': [...], 'data-analyst': [...], ... } }
      const allPresets = res?.presets || {}
      const presetScopes = allPresets[archetype]
      if (!presetScopes) { toast('error', `Archetype "${archetype}" not found`); return }
      
      // Build draft from preset scopes
      const draft: Record<string, { scopeType: string; accessLevel: string }> = {}
      for (const scope of presetScopes) {
        // Backend presets use camelCase: { scopeType, builtinName, groupName, connectorType, accessLevel }
        const scopeType = scope.scopeType
        if (scopeType === 'builtin' && scope.builtinName) {
          draft[`builtin:${scope.builtinName}`] = { scopeType: 'builtin', accessLevel: scope.accessLevel }
        } else if (scopeType === 'group' && scope.groupName) {
          draft[`group:${scope.groupName}`] = { scopeType: 'group', accessLevel: scope.accessLevel }
        } else if (scopeType === 'connectorType' && scope.connectorType) {
          // Match by connector tool_id (e.g. 'slack', 'jira', 'github') — set scope
          // for EVERY connector of that type the tenant has configured
          const matching = connectors.filter((c: any) => c.tool_id === scope.connectorType)
          for (const c of matching) {
            draft[`connector:${c.id}`] = { scopeType: 'connector', accessLevel: scope.accessLevel }
          }
          if (matching.length === 0) {
            console.log(`[presets] No ${scope.connectorType} connector found to apply preset`)
          }
        } else if (scopeType === 'connector' && scope.connectorId) {
          draft[`connector:${scope.connectorId}`] = { scopeType: 'connector', accessLevel: scope.accessLevel }
        } else if (scopeType === 'mcp_server' && scope.mcpServerId) {
          draft[`mcp:${scope.mcpServerId}`] = { scopeType: 'mcp_server', accessLevel: scope.accessLevel }
        }
      }
      setScopeDraft(draft)
      toast('info', `Archetype "${archetype}" presets applied`, 'Review and save to persist.')
    } catch (err: any) {
      toast('error', 'Failed to load presets', err.message)
    }
  }

  function updateScopeDraft(key: string, accessLevel: string) {
    setScopeDraft(prev => {
      const next = { ...prev }
      if (accessLevel === 'unset') {
        delete next[key]
      } else {
        // Infer scopeType from the key prefix (connector: / mcp: / builtin: / group:)
        const [type] = key.split(':')
        const scopeType = type === 'connector' ? 'connector'
          : type === 'mcp' ? 'mcp_server'
          : type === 'group' ? 'group'
          : 'builtin'
        next[key] = { ...next[key], scopeType, accessLevel }
      }
      return next
    })
  }

  function getScopeLevel(key: string): string {
    return scopeDraft[key]?.accessLevel || 'unset'
  }

  async function handleDelete() {
    if (deleteState === 0) {
      setDeleteState(1)
      setTimeout(() => setDeleteState(0), 4000)
      return
    }
    try {
      await api.deleteAgent(tenantId, agentId)
      toast('success', 'Agent deleted', 'The agent was successfully removed.')
      router.push('/dashboard/agents')
    } catch (err: any) {
      toast('error', 'Delete failed', err.message)
      setDeleteState(0)
    }
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
        // Include language for non-JS scripts
        if (newSkill.language === 'python') {
          config.language = 'python'
        }
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
      setNewSkill({ type: 'nl', name: '', description: '', instruction: '', code: '', url: '', method: 'GET', headers: '{\n  "Content-Type": "application/json"\n}', bodyTemplate: '', language: 'javascript' })
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
    cancellingRef.current = false
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
      if (err?.code === 'CIRCUIT_OPEN') {
        toast('error', 'Agent is paused (circuit open)', 'This agent failed too many recent tasks and was automatically blocked. Reset the circuit breaker in the Supervisor page to allow new tasks.')
      } else {
        toast('error', 'Task failed to start', err.message)
      }
      setRunning(false)
    }
  }

  async function cancelTask() {
    cancellingRef.current = true
    setRunning(false)
    setCurrentPhase('')
    if (wsRef.current) wsRef.current.close()
    if (pollRef.current) clearInterval(pollRef.current)
    setTraceEvents(prev => [...prev, { type: 'failed', error: 'Cancelled by user' }])
    
    // Also cancel it on the backend if we have a task ID
    if (task?.id || currentTaskId.current) {
      try {
        await api.cancelTask(tenantId, agentId, task?.id || currentTaskId.current)
        if (task) setTask({ ...task, status: 'CANCELLED' })
        setPastTasks(prev => prev.map(t => t.id === (task?.id || currentTaskId.current) ? { ...t, status: 'CANCELLED' } : t))
      } catch (err) {
        console.error('Backend cancel failed', err)
      }
    }
    
    cancellingRef.current = false
    toast('info', 'Task Stopped', 'The execution was stopped locally and on the server.')
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
            <h1 className="page-title" style={{ background: 'linear-gradient(135deg, #256329 0%, #3f8a43 45%, #0d9488 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{agent.name}</h1>
            <p className="page-sub">Configure agent properties and test autonomous goal execution</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className={`badge badge-${agent.status.toLowerCase()}`}>{agent.status}</span>
          {agent.archetype && <span className="badge" style={{ backgroundColor: 'rgba(139,92,246,0.12)', color: '#6d28d9', border: '1px solid rgba(139,92,246,0.3)', fontSize: 12, fontWeight: 700 }}>{agent.archetype}</span>}
          {agent.status === 'DRAFT' && <button className="btn btn-primary btn-sm" onClick={activate}>Activate Agent</button>}
          <button 
            className={`btn btn-sm ${deleteState === 1 ? 'btn-primary' : 'btn-secondary'}`} 
            style={deleteState === 1 ? { backgroundColor: 'var(--red)', borderColor: 'var(--red)' } : { color: 'var(--red)', borderColor: 'var(--border)' }}
            onClick={handleDelete}
          >
            {deleteState === 1 ? '⚠️ Click to confirm delete' : 'Delete Agent'}
          </button>
        </div>
      </div>

      <div className="page-body grid-2col" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 24, alignItems: 'start' }}>

        {/* Left Column: Properties */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minHeight: 0, overflowY: 'auto' }}>
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: 'linear-gradient(135deg, #3f8a43, #68b36c)', display: 'inline-block' }} />Worker Configuration</h2>
            <form onSubmit={updateAgent} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* ── Identity ─────────────────────────────────────────────── */}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 4, padding: '4px 10px', borderRadius: 999, background: 'rgba(63,138,67,0.12)', color: '#256329', border: '1px solid rgba(63,138,67,0.25)' }}>🧍 Identity</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div className="form-group">
                  <label className="form-label">Worker Name</label>
                  <input className="input" value={agent.name} onChange={e => setAgent({ ...agent, name: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Worker Description</label>
                  <input className="input" value={agent.description || ''} onChange={e => setAgent({ ...agent, description: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Archetype</label>
                <select className="input" value={agent.archetype || ''} onChange={e => setAgent({ ...agent, archetype: e.target.value })}>
                  <option value="">-- Select archetype --</option>
                  <option value="none">⚪ None — No template, user-defined behaviour only</option>
                  <option value="data-analyst">📊 Data Analyst — SQL queries &amp; dashboards</option>
                  <option value="research">🔬 Research — Web research &amp; intelligence gathering</option>
                  <option value="scientific">🧪 Scientific — Physics, chemistry, biology, math &amp; simulations</option>
                  <option value="medical">🏥 Medical — Clinical literature, drug info, healthcare data</option>
                  <option value="coordinator">🎯 Coordinator — Decompose &amp; delegate to other agents</option>
                  <option value="agent-generation">🏗️ Agent Generation — Create &amp; manage other agents</option>
                  <option value="developer">💻 Developer — Code, repos, CI/CD</option>
                  <option value="engineering">🏗️ Engineering — Civil, structural, mechanical design &amp; calcs</option>
                  <option value="iot">📡 IoT — Sensor data, devices, embedded systems</option>
                  <option value="data-entry">🌐 Data Entry — Web automation &amp; form filling</option>
                  <option value="customer-support">💬 Customer Support — Messaging &amp; notifications</option>
                  <option value="planner">📋 Planner — Project planning &amp; task management</option>
                  <option value="compliance">🔒 Compliance — Audit &amp; regulatory review</option>
                  <option value="document">📄 Document — Content &amp; report generation</option>
                  <option value="banking">🏦 Banking — Financial services, risk &amp; compliance</option>
                  <option value="insurance">🛟 Insurance — Claims, policies &amp; underwriting</option>
                  <option value="news-media">📰 News &amp; Media — Journalism, monitoring &amp; articles</option>
                  <option value="generalist">🤖 Generalist — Versatile multi-purpose agent</option>
                </select>
                <p className="form-hint" style={{ marginTop: 6 }}>
                  Determines the agent's default role, behaviour, and system prompt template.
                  Use <strong>Research</strong> for web-based tasks, <strong>Data Analyst</strong> for SQL/databases,
                  <strong>Developer</strong> for coding work.
                </p>
              </div>

              {/* ── Intelligence ────────────────────────────────────────── */}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 4, padding: '4px 10px', borderRadius: 999, background: 'rgba(16,185,129,0.12)', color: '#065f46', border: '1px solid rgba(16,185,129,0.3)' }}>🧠 Intelligence</div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <button type="button" onClick={() => setShowSystemPrompt(v => !v)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: 'rgba(16,185,129,0.07)', border: 'none', cursor: 'pointer', color: '#065f46', fontWeight: 700, fontSize: 13, borderLeft: '3px solid #10b981' }}>
                  <span>📜 System instructions (Guardrails & Constraints)</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{showSystemPrompt ? '▾ Hide' : `▸ Show (${agent.system_prompt?.length || 0} chars)`}</span>
                </button>
                {showSystemPrompt && (
                  <div style={{ padding: '0 14px 14px' }}>
                    <textarea className="input" rows={6} value={agent.system_prompt || ''} onChange={e => setAgent({ ...agent, system_prompt: e.target.value })} />
                  </div>
                )}
              </div>
              {/* ── Runtime ────────────────────────────────────────────── */}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 4, padding: '4px 10px', borderRadius: 999, background: 'rgba(59,130,246,0.12)', color: '#1d4ed8', border: '1px solid rgba(59,130,246,0.25)' }}>⚙️ Runtime</div>
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
                      value={agent.llm_model === 'auto' || !agent.llm_model ? 'auto' : (agent.llm_provider || '')}
                      onChange={e => {
                        const p = e.target.value
                        if (p === 'auto') {
                          // System default: use the tenant's Settings default provider + model at runtime
                          setAgent({ ...agent, llm_provider: null, llm_model: 'auto' })
                          return
                        }
                        // Prefer the provider's saved model; otherwise use current model
                        // (but not 'auto' — that's a sentinel, not a real model)
                        const providerModel = llmProviders[p]?.model
                        const currentModel = agent.llm_model === 'auto' ? '' : agent.llm_model
                        const suggested = providerModel || currentModel
                        setAgent({ ...agent, llm_provider: p, llm_model: suggested })
                      }}
                    >
                      <option value="auto">⚙️ System default (from Settings)</option>
                      {/* Preserve the agent's current provider even if it was removed from settings */}
                      {agent.llm_provider && agent.llm_model !== 'auto' && !llmProviders[agent.llm_provider] && (
                        <option value={agent.llm_provider}>{PROVIDER_LABELS[agent.llm_provider] || agent.llm_provider} (not configured)</option>
                      )}
                      {Object.keys(llmProviders).map(pid => (
                        <option key={pid} value={pid}>{PROVIDER_LABELS[pid] || pid}</option>
                      ))}
                    </select>
                    {(() => {
                      // System default — no model to choose, provider not set
                      if (agent.llm_model === 'auto' && !agent.llm_provider) {
                        return (
                          <input className="input" value="Using system default" disabled style={{ opacity: 0.6 }} />
                        )
                      }
                      const completedCustom = customModels.filter(cm => cm.status === 'COMPLETED')
                      const hasOllamaModels = agent.llm_provider === 'ollama' && (ollamaModels.length > 0 || completedCustom.length > 0)
                      if (hasOllamaModels) {
                        return (
                          <select className="input" value={agent.llm_model || ''} onChange={e => setAgent({ ...agent, llm_model: e.target.value })} required>
                            <option value="" disabled>Select a model...</option>
                            {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
                            {completedCustom.length > 0 && ollamaModels.length > 0 && <option disabled>── Trained Models ──</option>}
                            {completedCustom.map(cm => (
                              <option key={cm.id} value={cm.ollama_tag || cm.model_name}>
                                {cm.model_name} ✨
                              </option>
                            ))}
                          </select>
                        )
                      }
                      return (
                        <input className="input" value={agent.llm_model || ''} onChange={e => setAgent({ ...agent, llm_model: e.target.value })} placeholder={LOCAL_PROVIDERS.has(agent.llm_provider) ? 'e.g. llama3.2' : 'Model name'} required />
                      )
                    })()}
                  </div>
                )}
                <p className="form-hint" style={{ marginTop: 6 }}>
                  Each agent can use its own provider and model. Manage providers in <Link href="/dashboard/settings" style={{ color: 'var(--green-dark)' }}>Settings</Link>.
                </p>
              </div>
              <div className="form-group">
                <label className="form-label">Autonomy Level</label>
                <select
                  className="input"
                  value={agent.autonomy_level || 'SUPERVISED'}
                  onChange={e => setAgent({ ...agent, autonomy_level: e.target.value })}
                >
                  <option value="SUPERVISED">🔒 SUPERVISED — Approve before sensitive actions</option>
                  <option value="GUARDED">🛡️ GUARDED — Only approve high-risk tools</option>
                  <option value="AUTONOMOUS">🚀 AUTONOMOUS — No approval required</option>
                </select>
                <p className="form-hint" style={{ marginTop: 6 }}>
                  {agent.autonomy_level === 'AUTONOMOUS' ? (
                    'Agent runs all tools without any human oversight. Use only for safe, repetitive tasks.'
                  ) : agent.autonomy_level === 'GUARDED' ? (
                    'Approval required for: SSH exec, Docker run, HTTP requests, file downloads. Safe tools run freely.'
                  ) : (
                    'Approval required for: HTTP requests, shell/docker exec, browser, publish, delegate, write artifacts, SQL writes. Best for first runs and critical workflows.'
                  )}
                </p>
              </div>
              {/* ── Database Strategy ──────────────────────────────────── */}
              <div className="form-group">
                <label className="form-label">Database Strategy</label>
                <select
                  className="input"
                  value={agent.data_strategy || 'source'}
                  onChange={e => setAgent({ ...agent, data_strategy: e.target.value })}
                >
                  <option value="source">📥 Database as Source (Read-only: SELECT, explore, profile)</option>
                  <option value="target">📤 Database as Target (Write-only: CREATE/INSERT, build schemas)</option>
                  <option value="both">🔄 Both Source &amp; Target (Read + Write)</option>
                  <option value="none">🚫 No Database (KB, files, APIs only)</option>
                </select>
                <p className="form-hint" style={{ marginTop: 6 }}>
                  Tells the agent how to treat the database. <strong>Source</strong> = read-only exploration. <strong>Target</strong> = build/write tables. <strong>Both</strong> = profile and transform. <strong>None</strong> = no DB access.
                </p>
              </div>
              {/* ── Memory toggle ────────────────────────────────────── */}
              <div className="form-group">
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={!!agent.use_memory}
                    onChange={e => setAgent({ ...agent, use_memory: e.target.checked })}
                    style={{ accentColor: '#10b981', width: 18, height: 18 }}
                  />
                  🧠 Use Agent Memory (cross-task context)
                </label>
                <p className="form-hint" style={{ marginTop: 6, marginLeft: 26 }}>
                  When <strong>enabled</strong>, facts and past task summaries from the 🧠 Agent Memory card below are injected into the system prompt as context.
                  When <strong>off</strong> (default), every task starts fresh — the agent won't remember anything from previous executions.
                </p>
              </div>
              {/* ── Knowledge ───────────────────────────────────────────── */}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 4, padding: '4px 10px', borderRadius: 999, background: 'rgba(16,185,129,0.12)', color: '#065f46', border: '1px solid rgba(16,185,129,0.3)' }}>📚 Knowledge</div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <button type="button" onClick={() => setShowKnowledge(v => !v)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: 'rgba(16,185,129,0.07)', border: 'none', cursor: 'pointer', color: '#065f46', fontWeight: 700, fontSize: 13, borderLeft: '3px solid #10b981' }}>
                  <span>📎 Attached knowledge</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{showKnowledge ? '▾ Hide' : `▸ Show (${selectedKBs.length} KBs, ${selectedGraphs.length} graphs)`}</span>
                </button>
                {showKnowledge && (
                  <div style={{ padding: '0 14px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
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
                                }} style={{ accentColor: '#10b981' }} />
                                <strong>{kb.name}</strong> ({kb.document_count || 0} docs)
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                    <div className="form-group">
                      <label className="form-label">Attached Knowledge Graphs</label>
                      {graphs.length === 0 ? (
                        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No knowledge graphs found. <Link href="/dashboard/knowledge?tab=graphs" style={{ color: '#10b981' }}>Create one</Link></div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                          {graphs.map(g => {
                            const isSelected = selectedGraphs.includes(g.id)
                            return (
                              <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                                <input type="checkbox" checked={isSelected} onChange={() => {
                                  setSelectedGraphs(prev => isSelected ? prev.filter(i => i !== g.id) : [...prev, g.id])
                                }} style={{ accentColor: '#10b981' }} />
                                <strong>{g.name}</strong> ({g.entity_count || 0} entities, {g.graph_kind})
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div style={{ position: 'sticky', bottom: 12, background: 'color-mix(in srgb, var(--surface) 90%, transparent)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'flex-end', backdropFilter: 'blur(6px)' }}>
                <button className="btn btn-primary" type="submit">Save Configuration</button>
              </div>
            </form>
          </div>

          {/* Custom Skills Section */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: 'linear-gradient(135deg, #8b5cf6, #a78bfa)', display: 'inline-block' }} />Custom Skills</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowSkillModal(true)}>+ Add Skill</button>
            </div>
            {agent.skills?.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 300, overflowY: 'auto', paddingRight: 8 }}>
                {agent.skills.map((s: any) => (
                  <div key={s.id} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, position: 'relative' }}>
                    <button 
                      onClick={(e) => handleRemoveSkill(e, s.id)}
                      style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', opacity: 0.6 }}
                      title="Remove skill"
                      onMouseOver={e => e.currentTarget.style.opacity = '1'}
                      onMouseOut={e => e.currentTarget.style.opacity = '0.6'}
                    >🗑</button>
                    <div style={{ fontWeight: 600, fontSize: 14, paddingRight: 24 }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.description}</div>
                    {s.action_id === 'nl_instruction' && <div style={{ marginTop: 8, fontSize: 11, background: 'var(--surface)', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace', color: '#a855f7', display: 'inline-block' }}>Natural Language</div>}
                    {s.config?.language === 'python' && s.config?.code && <div style={{ marginTop: 8, fontSize: 11, background: 'var(--surface)', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace', color: '#3776AB', display: 'inline-block' }}>🐍 Python Script</div>}
                    {(!s.config?.language || s.config?.language === 'javascript') && s.config?.code && <div style={{ marginTop: 8, fontSize: 11, background: 'var(--surface)', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace', color: 'var(--green-dark)', display: 'inline-block' }}>JS Script</div>}
                    {s.config?.url && <div style={{ marginTop: 8, fontSize: 11, background: 'rgba(59,130,246,0.1)', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace', color: '#1d4ed8', display: 'inline-block' }}>API Endpoint</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No custom skills attached.</div>
            )}
          </div>

          {/* ════════════════════════════════════════════════════════════════
             Tool Capabilities — scope which connectors, MCP servers, and
             built-in tools this agent is allowed to use.
             ════════════════════════════════════════════════════════════════ */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
            {/* ── LEFT: Tool scopes ─────────────────────────────────────────── */}
            <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: 'linear-gradient(135deg, #3b82f6, #60a5fa)', display: 'inline-block' }} />Tool Capabilities</h2>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {agent?.archetype && (
                  <button className="btn btn-primary btn-sm" onClick={() => applyArchetypePresets(agent.archetype)} title={`Apply "${agent.archetype}" preset for this agent's archetype`} style={{ fontWeight: 700 }}>
                    ⭐ My Preset
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => applyArchetypePresets('customer-support')} title="Apply customer-support presets">🎧 Support</button>
                <button className="btn btn-secondary btn-sm" onClick={() => applyArchetypePresets('data-analyst')} title="Apply data-analyst presets">📊 Data</button>
                <button className="btn btn-secondary btn-sm" onClick={() => applyArchetypePresets('developer')} title="Apply developer presets">💻 Dev</button>
                <button className="btn btn-secondary btn-sm" onClick={() => applyArchetypePresets('browser-automation')} title="Apply browser-automation presets">🌐 Browser</button>
                <button className="btn btn-secondary btn-sm" onClick={() => applyArchetypePresets('analyst')} title="Apply analyst presets (read-only)">🔒 Analyst</button>
              </div>
            </div>
            {agent?.archetype ? (
              <div style={{ fontSize: 12, padding: '8px 12px', backgroundColor: 'color-mix(in srgb, var(--blue) 10%, transparent)', borderRadius: 6, marginBottom: 12, color: 'var(--text-secondary)', border: '1px solid color-mix(in srgb, var(--blue) 25%, transparent)' }}>
                💡 This agent's archetype is <strong>{agent.archetype}</strong>. Default tool scopes were applied at creation. Review and adjust below, or click <strong>⭐ My Preset</strong> to reload the archetype defaults.
              </div>
            ) : (
              <div style={{ fontSize: 12, padding: '8px 12px', backgroundColor: 'color-mix(in srgb, var(--yellow) 10%, transparent)', borderRadius: 6, marginBottom: 12, color: 'var(--text-secondary)', border: '1px solid color-mix(in srgb, var(--yellow) 25%, transparent)' }}>
                ⚠️ This agent has no archetype. Without explicit scopes, it will have access to <strong>all tools</strong>. Choose a preset above to apply least-privilege defaults — then review and save.
              </div>
            )}
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
              Explicitly scoped items control what this agent can use. <strong>Allowed</strong> grants access, <strong>Not allowed</strong> blocks implicitly (unless all connectors are allowed). <strong>Requires approval</strong> pauses execution for human review before use.
              {loadingScopes && <span style={{ marginLeft: 8, color: 'var(--text-secondary)' }}>⏳ Loading...</span>}
            </p>

            {loadingScopes ? (
              <div className="skeleton" style={{ height: 120 }} />
            ) : (
              <>
                {/* ── Connectors ──────────────────────────────────────────── */}
                {(() => {
                  // Exclude vector-db & knowledge-graph connectors — these are now managed as Knowledge Bases / Graphs
                  const nonKnowledgeConnectors = connectors.filter((c: any) => c.tool_id !== 'vector-db' && c.tool_id !== 'knowledge-graph')
                  const assignedConnectors = nonKnowledgeConnectors.filter((c: any) => getScopeLevel(`connector:${c.id}`) !== 'unset')
                  const unassignedConnectors = nonKnowledgeConnectors.filter((c: any) => getScopeLevel(`connector:${c.id}`) === 'unset')
                  const visibleConnectors = showAllConnectors ? nonKnowledgeConnectors : assignedConnectors
                  const totalAssigned = assignedConnectors.length
                  return (
                <details open style={{ marginBottom: 12 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                    🔌 Connectors ({totalAssigned} assigned{nonKnowledgeConnectors.length !== totalAssigned ? ` / ${nonKnowledgeConnectors.length} total` : ''})
                  </summary>
                  {connectors.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', paddingLeft: 16 }}>No connectors configured.</div>
                  ) : visibleConnectors.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', paddingLeft: 16 }}>
                      No connectors assigned to this agent.{' '}
                      <button className="btn-link" onClick={() => setShowAllConnectors(true)}
                        style={{ fontSize: 12, color: 'var(--green-dark)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        Show all {connectors.length} connectors
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16 }}>
                      {visibleConnectors.map((c: any) => {
                        const key = `connector:${c.id}`
                        const level = getScopeLevel(key)
                        const icon = c.tool_id === 'database' ? '🗄️' : c.tool_id === 'rest' ? '🌐' : c.tool_id === 'webhook' ? '🔗' : c.tool_id === 'local-dir' ? '📁' : c.tool_id === 'local-shell' ? '💻' : c.tool_id === 'local-applescript' ? '🍎' : '🔌'
                        // Show config details for multi-instance connectors
                        const detail = c.tool_id === 'database'
                          ? `${c.config?.engine || 'sql'}://${c.config?.host || 'localhost'}:${c.config?.port || 5432}/${c.config?.database || c.config?.database_name || '?'}`
                          : c.tool_id === 'local-dir'
                          ? c.config?.path || ''
                          : c.tool_id === 'rest'
                          ? c.config?.baseUrl || ''
                          : c.tool_id === 'webhook'
                          ? c.config?.url || ''
                          : c.tool_id === 'local-shell'
                          ? c.config?.shell || 'bash'
                          : ''
                        return (
                          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                            <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
                            <span style={{ flex: 1 }}>
                              <strong>{c.name}</strong>
                              {detail && <span style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block', fontFamily: 'monospace' }}>{detail}</span>}
                              <span style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block' }}>{c.tool_id}{c.status !== 'ACTIVE' ? ` · ${c.status}` : ''}</span>
                            </span>
                            <select className="input" style={{ width: 150, fontSize: 12, padding: '4px 6px' }}
                              value={level}
                              onChange={e => updateScopeDraft(key, e.target.value)}>
                              <option value="unset">🚫 Not allowed</option>
                              <option value="allowed">✅ Allowed</option>
                              <option value="readonly">👁 Read only</option>
                              <option value="requires_approval">🛑 Requires approval</option>
                              <option value="denied">⛔ Denied</option>
                            </select>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {!showAllConnectors && unassignedConnectors.length > 0 && (
                    <button className="btn-link" onClick={() => setShowAllConnectors(true)}
                      style={{ fontSize: 11, marginTop: 6, marginLeft: 16, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      + Show all {nonKnowledgeConnectors.length} connectors ({unassignedConnectors.length} more)
                    </button>
                  )}
                  {showAllConnectors && unassignedConnectors.length > 0 && (
                    <button className="btn-link" onClick={() => setShowAllConnectors(false)}
                      style={{ fontSize: 11, marginTop: 6, marginLeft: 16, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      − Show assigned only
                    </button>
                  )}
                </details>
                )})()}

                {/* ── MCP Servers ─────────────────────────────────────────── */}
                {(() => {
                  const assignedMcp = mcpServers.filter((s: any) => getScopeLevel(`mcp:${s.id}`) !== 'unset')
                  const unassignedMcp = mcpServers.filter((s: any) => getScopeLevel(`mcp:${s.id}`) === 'unset')
                  const visibleMcp = showAllMcp ? mcpServers : assignedMcp
                  const totalAssignedMcp = assignedMcp.length
                  return (
                <details open style={{ marginBottom: 12 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                    🖥 MCP Servers ({totalAssignedMcp} assigned{mcpServers.length !== totalAssignedMcp ? ` / ${mcpServers.length} total` : ''})
                  </summary>
                  {mcpServers.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', paddingLeft: 16 }}>No MCP servers configured.</div>
                  ) : visibleMcp.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', paddingLeft: 16 }}>
                      No MCP servers assigned to this agent.{' '}
                      <button className="btn-link" onClick={() => setShowAllMcp(true)}
                        style={{ fontSize: 12, color: 'var(--green-dark)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        Show all {mcpServers.length} servers
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16 }}>
                      {visibleMcp.map((s: any) => {
                        const key = `mcp:${s.id}`
                        const level = getScopeLevel(key)
                        return (
                          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                            <span style={{ flex: 1 }}><strong>{s.name}</strong> <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({s.url || s.base_url || ''})</span></span>
                            <select className="input" style={{ width: 150, fontSize: 12, padding: '4px 6px' }}
                              value={level}
                              onChange={e => updateScopeDraft(key, e.target.value)}>
                              <option value="unset">🚫 Not allowed</option>
                              <option value="allowed">✅ Allowed</option>
                              <option value="readonly">👁 Read only</option>
                              <option value="requires_approval">🛑 Requires approval</option>
                              <option value="denied">⛔ Denied</option>
                            </select>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {!showAllMcp && unassignedMcp.length > 0 && (
                    <button className="btn-link" onClick={() => setShowAllMcp(true)}
                      style={{ fontSize: 11, marginTop: 6, marginLeft: 16, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      + Show all {mcpServers.length} servers ({unassignedMcp.length} more)
                    </button>
                  )}
                  {showAllMcp && unassignedMcp.length > 0 && (
                    <button className="btn-link" onClick={() => setShowAllMcp(false)}
                      style={{ fontSize: 11, marginTop: 6, marginLeft: 16, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      − Show assigned only
                    </button>
                  )}
                </details>
                )})()}

                {/* ── Groups ──────────────────────────────────────────────── */}
                <details open style={{ marginBottom: 12 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                    🏷️ Groups ({['communication', 'database', 'development', 'analytics', 'devops'].length})
                  </summary>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 16, marginBottom: 8 }}>
                    Groups let you tag connectors with a category (via <code>config.group</code>). 
                    Enabling a group here grants access to all connectors in that category.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16 }}>
                    {['communication', 'database', 'development', 'analytics', 'devops'].map(groupName => {
                      const key = `group:${groupName}`
                      const level = getScopeLevel(key)
                      return (
                        <div key={groupName} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                          <span style={{ flex: 1 }}><strong>{groupName}</strong></span>
                          <select className="input" style={{ width: 150, fontSize: 12, padding: '4px 6px' }}
                            value={level}
                            onChange={e => updateScopeDraft(key, e.target.value)}>
                            <option value="unset">🚫 Not allowed</option>
                            <option value="allowed">✅ Allowed</option>
                            <option value="readonly">👁 Read only</option>
                            <option value="denied">⛔ Denied</option>
                          </select>
                        </div>
                      )
                    })}
                  </div>
                </details>

                {/* ── Built-in Tools ──────────────────────────────────────── */}
                <details open>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                    ⚙ Built-in Tools ({BUILTIN_TOOLS.length})
                  </summary>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16 }}>
                    {BUILTIN_TOOLS.map(tool => {
                      const key = `builtin:${tool.id}`
                      const level = getScopeLevel(key)
                      const isBrowserUse = tool.id === 'browser_use'
                      return (
                        <div key={tool.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                          <span style={{ flex: 1 }}><strong>{tool.name}</strong> <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{tool.description}</span></span>
                          {isBrowserUse && (
                            <button
                              className="btn btn-sm"
                              onClick={testBrowserAgent}
                              disabled={browserStatus === 'testing'}
                              style={{
                                fontSize: 10, padding: '2px 8px', marginRight: 4,
                                backgroundColor: browserStatus === 'ok' ? 'rgba(16,185,129,0.15)' : browserStatus === 'error' ? 'rgba(239,68,68,0.15)' : 'transparent',
                                color: browserStatus === 'ok' ? '#10b981' : browserStatus === 'error' ? '#ef4444' : 'var(--text-muted)',
                                border: `1px solid ${browserStatus === 'ok' ? 'rgba(16,185,129,0.3)' : browserStatus === 'error' ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                              }}
                              title="Test browser-agent sidecar connectivity"
                            >
                              {browserStatus === 'testing' ? '⟳' : browserStatus === 'ok' ? '✓ Connected' : browserStatus === 'error' ? '✗ Offline' : '🔍 Test'}
                            </button>
                          )}
                          <select className="input" style={{ width: 150, fontSize: 12, padding: '4px 6px' }}
                            value={level}
                            onChange={e => updateScopeDraft(key, e.target.value)}>
                            <option value="unset">✅ Allowed (default)</option>
                            <option value="allowed">✅ Allowed</option>
                            <option value="denied">⛔ Denied</option>
                            <option value="requires_approval">🛑 Requires approval</option>
                          </select>
                        </div>
                      )
                    })}
                  </div>
                </details>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                  <button className="btn btn-primary btn-sm" onClick={saveScopes}>Save Capabilities</button>
                </div>
              </>
            )}
          </div>
        </div>
          </div>
        </div>

        {/* Right Column: Teach Agent + Live Execution */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minHeight: 0, overflowY: 'auto' }}>

          {/* ─── Execution Goal card ─────────────────────────────── */}
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: 'linear-gradient(135deg, #f59e0b, #fbbf24)', display: 'inline-block' }} />Execution Goal</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
              Provide a high-level goal. The agent will plan, retrieve knowledge, call tools, and stream results live.
            </p>

            <form onSubmit={startTask} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
              <textarea className="input" rows={3}
                placeholder="e.g. Audit the Acme lease agreement PDF and flag any non-standard termination clauses."
                value={goal} onChange={e => { setGoal(e.target.value); setAutoLoadedGoal(false); }} required
                disabled={agent.status !== 'ACTIVE' || running} />
              {autoLoadedGoal && goal && (
                <div style={{ fontSize: 11, color: '#059669', fontWeight: 600, marginTop: -8, display: 'flex', alignItems: 'center', gap: 4 }}>
                  🔄 Using prompt from last successful run — edit above or click a past execution below
                </div>
              )}
              
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
                  <button type="button" className="btn btn-danger-solid" onClick={cancelTask} style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>
                    ⏹ Stop
                  </button>
                )}
              </div>
            </form>

            {agent.status !== 'ACTIVE' && (
              <div className="alert alert-warning">⚠ You must Activate this Agent before sending it goals.</div>
            )}

            {/* Live streaming trace — reserve space only while running to prevent layout jumps */}
            <div style={{ marginTop: 8, minHeight: (running || task?.result || traceEvents.length > 0) ? 200 : 0 }}>
              {(traceEvents.length > 0 || running || task?.result) ? (
              <div className="animate-in">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>Live Execution Trace</span>
                  {task?.status && (
                    <span className={`badge badge-${task.status.toLowerCase()}`}>{task.status}</span>
                  )}
                </div>

                <div ref={traceContainerRef}
                  onScroll={() => {
                    const el = traceContainerRef.current
                    if (!el) return
                    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
                    // User scrolled up >100px from bottom → pause auto-scroll
                    if (distFromBottom > 100) {
                      userScrolledUpRef.current = true
                    } else {
                      // User scrolled back to bottom → resume auto-scroll
                      userScrolledUpRef.current = false
                    }
                  }}
                  style={{
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
                        <pre style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 11, maxHeight: 200, overflowY: 'auto', background: '#0a0d14', borderRadius: 4, padding: '6px 8px' }}>
                          {ev.tool === 'runQuery' && typeof ev.input?.query === 'string'
                            ? ev.input.query
                            : JSON.stringify(ev.input, null, 2)}
                        </pre>
                      </div>
                    )
                    if (ev.type === 'tool_result') return (
                      <div key={i} style={{ borderLeft: `3px solid ${ev.success ? '#22c55e' : '#ef4444'}`, paddingLeft: 10 }}>
                        <span style={{ color: ev.success ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                          {ev.success ? '✓' : '✗'} {ev.tool}
                        </span>
                        <pre style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 11, maxHeight: 400, overflowY: 'auto', background: '#0a0d14', borderRadius: 4, padding: '6px 8px' }}>
                          {JSON.stringify(ev.output, null, 2)}
                        </pre>
                      </div>
                    )
                    if (ev.type === 'completed') return (
                      <div key={i} style={{ borderTop: '1px solid #1e293b', paddingTop: 10, color: '#22c55e', fontWeight: 700 }}>
                        ✓ Task completed · confidence {Math.round((ev.confidence || 0) * 100)}% · {ev.tokensUsed?.toLocaleString()} tokens{ev.durationMs ? ` · cycle time ${(ev.durationMs / 1000).toFixed(1)}s` : ''}
                      </div>
                    )
                    if (ev.type === 'failed') return (
                      <div key={i} style={{ borderTop: '1px solid #1e293b', paddingTop: 10 }}>
                        <div style={{ color: '#ef4444', fontWeight: 700, marginBottom: 4 }}>✗ Task failed</div>
                        <div style={{ color: '#fca5a5', whiteSpace: 'pre-wrap', background: '#1a1219', borderRadius: 6, padding: '8px 10px', fontSize: 12, maxHeight: 300, overflowY: 'auto' }}>
                          {ev.error}
                        </div>
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
            ) : null}
            </div>
          </div>



          {/* Past Executions */}
          <div className="card" style={{ padding: 24, marginTop: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: 'linear-gradient(135deg, #0d9488, #2dd4bf)', display: 'inline-block' }} />Past Executions</h2>
              {pastTasks.length > 5 && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowAllTasks(!showAllTasks)}
                >
                  {showAllTasks ? 'Show less' : `View all (${pastTasks.length})`}
                </button>
              )}
            </div>
            {pastTasks.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.5 }}>📋</div>
                <div style={{ fontSize: 13 }}>No past executions yet.</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Run a task from the agent chat to see it here.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 400, overflowY: 'auto' }}>
                {(showAllTasks ? pastTasks : pastTasks.slice(0, 5)).map(t => (
                  <div 
                    key={t.id} 
                    style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', transition: 'border-color 0.2s', position: 'relative' }} 
                    onClick={() => { setTask(t); setGoal(t.goal); setTraceEvents([]); }}
                    onMouseOver={e => e.currentTarget.style.borderColor = 'var(--green-dark)'}
                    onMouseOut={e => e.currentTarget.style.borderColor = 'var(--border)'}
                  >
                    <button 
                      onClick={(e) => handleDeleteTask(e, t.id)}
                      style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', opacity: 0.6 }}
                      title="Delete execution"
                      onMouseOver={e => e.currentTarget.style.opacity = '1'}
                      onMouseOut={e => e.currentTarget.style.opacity = '0.6'}
                    >🗑</button>
                    {(t.status === 'RUNNING' || t.status === 'PENDING') && (
                      <button 
                        onClick={(e) => handleCancelTask(e, t.id)}
                        style={{ position: 'absolute', top: 10, right: 36, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', padding: '3px 10px', fontSize: 11, fontWeight: 700 }}
                        title="Stop execution"
                      >⏹ STOP</button>
                    )}
                    {(t.status === 'FAILED' || t.status === 'CANCELLED') && (
                      <div style={{ position: 'absolute', top: 10, right: 36, display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                        {t.execution_checkpoint && (
                          <button
                            disabled={retryingTaskId === t.id}
                            onClick={(e) => handleRetryTask(e, t.id, 'checkpoint')}
                            style={{ background: '#0d9488', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', padding: '3px 10px', fontSize: 11, fontWeight: 700, opacity: retryingTaskId === t.id ? 0.6 : 1 }}
                            title="Resume from last checkpoint"
                          >⟳ Resume</button>
                        )}
                        <button
                          disabled={retryingTaskId === t.id}
                          onClick={(e) => handleRetryTask(e, t.id, 'fresh')}
                          style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', padding: '3px 10px', fontSize: 11, fontWeight: 700, opacity: retryingTaskId === t.id ? 0.6 : 1 }}
                          title="Re-run from scratch"
                        >↺ Restart</button>
                      </div>
                    )}
                     <div style={{ fontWeight: 400, fontSize: 13, marginBottom: 6, lineHeight: 1.5 }}>{t.goal}</div>
                     <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                       <span className={`badge badge-${t.status.toLowerCase()}`}>{t.status}</span>
                       <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(t.created_at).toLocaleString()}</span>
                     </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ─── Prompt Settings card ───────────────────────────────────────── */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: 'linear-gradient(135deg, #7c3aed, #a78bfa)', display: 'inline-block' }} />📋 Prompt Settings</h2>
              <button className="btn btn-secondary btn-sm" onClick={loadPromptPreview} disabled={loadingPromptPreview} style={{ fontSize: 12 }}>
                {loadingPromptPreview ? '⟳ Loading...' : promptPreview ? '↻ Refresh' : '🔍 Load Preview'}
              </button>
            </div>

            {/* Status: what gets sent on every run — always visible */}
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 14, border: '1px solid var(--border)', marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>Sent to LLM each run</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{
                    padding: '4px 12px', borderRadius: 20, fontSize: 13, fontWeight: 700,
                    background: agent?.compress_system_prompt ? 'rgba(16,185,129,0.15)' : agent?.local_refine_prompt ? 'rgba(245,158,11,0.15)' : 'rgba(100,116,139,0.12)',
                    color: agent?.compress_system_prompt ? '#10b981' : agent?.local_refine_prompt ? '#f59e0b' : 'var(--text-secondary)',
                    border: `1px solid ${agent?.compress_system_prompt ? 'rgba(16,185,129,0.3)' : agent?.local_refine_prompt ? 'rgba(245,158,11,0.3)' : 'var(--border)'}`,
                  }}>
                    {agent?.compress_system_prompt ? '⚡ AI compressed' : agent?.local_refine_prompt ? '✂️ Local trimmed' : '📄 Full prompt'}
                  </span>
                  {agent?.chunked_prompt && (
                    <span style={{ padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}>
                      🧩 Chunked delivery
                    </span>
                  )}
                  {(() => {
                    let label = ''
                    if (promptMode === 'local' && localPreview)
                      label = `~${localPreview.compressedTokens} tokens • saved ${localPreview.savedPct}%`
                    else if (promptMode === 'summarised' && compressedPreview)
                      label = `~${compressedPreview.compressedTokens} tokens • saved ${compressedPreview.savedPct}%`
                    else if (promptPreview)
                      label = agent?.chunked_prompt && promptPreview.chunkStats
                        ? `~${promptPreview.estimatedTokens} tokens • ${promptPreview.chunkStats.sectionCount} sections (~${promptPreview.chunkStats.tokensPerChunk}/chunk)`
                        : `~${promptPreview.estimatedTokens} tokens`
                    if (!label) return null
                    return (
                      <span style={{
                        padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                        background: 'rgba(59,130,246,0.12)', color: '#3b82f6',
                        border: '1px solid rgba(59,130,246,0.3)',
                      }}>
                        🔢 {label}
                      </span>
                    )
                  })()}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Mode:</div>
                <button
                  className={`btn btn-sm ${agent?.compress_system_prompt ? 'btn-primary' : agent?.local_refine_prompt ? 'btn-warning' : 'btn-secondary'}`}
                  style={{ fontSize: 11 }}
                  disabled={savingPromptMode}
                  title="Cycle: Full → ✂️ Local (instant, no LLM) → ⚡ AI (cached once) → Full"
                  onClick={async () => {
                    setSavingPromptMode(true)
                    const isAI = !!agent?.compress_system_prompt
                    const isLocal = !!agent?.local_refine_prompt && !isAI
                    let nextAI = false, nextLocal = false
                    if (!isAI && !isLocal) nextLocal = true
                    else if (isLocal) nextAI = true
                    try {
                      await api.updateAgent(tenantId, agentId, { compressSystemPrompt: nextAI, localRefinePrompt: nextLocal })
                      setAgent((a: any) => ({ ...a, compress_system_prompt: nextAI, local_refine_prompt: nextLocal }))
                      toast('success', nextAI ? 'AI compression on' : nextLocal ? 'Local trim on' : 'Full prompt mode', '')
                      if (nextLocal && !localPreview) {
                        const r = await api.compressPrompt(tenantId, agentId, false, 'local', goal)
                        setLocalPreview(r.data); setPromptMode('local')
                      } else if (nextAI && !compressedPreview) {
                        const r = await api.compressPrompt(tenantId, agentId, false, 'ai', goal)
                        setCompressedPreview(r.data); setPromptMode('summarised')
                      }
                    } catch { toast('error', 'Failed to save', '') }
                    finally { setSavingPromptMode(false) }
                  }}
                >
                  {savingPromptMode ? '⟳' : agent?.compress_system_prompt ? '⚡ AI' : agent?.local_refine_prompt ? '✂️ Local' : '📄 Full'}
                </button>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Delivery:</div>
                <button
                  className={`btn btn-sm ${agent?.chunked_prompt ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ fontSize: 11 }}
                  disabled={savingPromptMode}
                  title="Split by ## headings — LLM waits for all parts before acting"
                  onClick={async () => {
                    setSavingPromptMode(true)
                    const next = !agent?.chunked_prompt
                    try {
                      await api.updateAgent(tenantId, agentId, { chunkedPrompt: next })
                      setAgent((a: any) => ({ ...a, chunked_prompt: next }))
                      toast('success', next ? 'Chunked delivery ON' : 'Single delivery', '')
                    } catch { toast('error', 'Failed to save', '') }
                    finally { setSavingPromptMode(false) }
                  }}
                >
                  {agent?.chunked_prompt ? '🧩 Chunked' : '🧩 Single'}
                </button>
              </div>
            </div>

            {/* Preview tabs + text area */}
            {promptPreview && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
                {(['full', 'local', 'summarised'] as const).map(id => (
                  <button key={id}
                    className={`btn btn-sm ${promptMode === id ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: 11 }}
                    disabled={(id === 'local' && loadingLocal) || (id === 'summarised' && loadingCompressed)}
                    onClick={async () => {
                      setPromptMode(id)
                      if (id === 'local' && !localPreview) {
                        setLoadingLocal(true)
                        try { const r = await api.compressPrompt(tenantId, agentId, false, 'local', goal); setLocalPreview(r.data) }
                        catch { toast('error', 'Failed', '') } finally { setLoadingLocal(false) }
                      }
                      if (id === 'summarised' && !compressedPreview) {
                        setLoadingCompressed(true)
                        try { const r = await api.compressPrompt(tenantId, agentId, false, 'ai', goal); setCompressedPreview(r.data) }
                        catch { toast('error', 'Failed', '') } finally { setLoadingCompressed(false) }
                      }
                    }}
                  >
                    {id === 'local' && loadingLocal ? '⟳' : id === 'summarised' && loadingCompressed ? '⟳' : id === 'full' ? '📄 Full' : id === 'local' ? '✂️ Local' : '⚡ AI'}
                  </button>
                ))}
                {promptMode === 'local' && localPreview && <span style={{ fontSize: 11, color: '#f59e0b', marginLeft: 4 }}>saves {localPreview.savedPct}%</span>}
                {promptMode === 'summarised' && compressedPreview && <span style={{ fontSize: 11, color: '#10b981', marginLeft: 4 }}>saves {compressedPreview.savedPct}%</span>}
              </div>
            )}
            {promptPreview ? (
              <div style={{ maxHeight: 340, overflowY: 'auto', background: '#0d1117', borderRadius: 8, padding: '12px 16px', border: '1px solid var(--border)' }}>
                <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: '#c9d1d9', fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {promptMode === 'local' && localPreview ? localPreview.compressedPrompt
                    : promptMode === 'summarised' && compressedPreview ? compressedPreview.compressedPrompt
                    : promptPreview.systemPrompt}
                </pre>
              </div>
            ) : (
              <div
                style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '28px 0', border: '1px dashed var(--border)', borderRadius: 8, cursor: 'pointer' }}
                onClick={loadPromptPreview}
              >
                🔍 Click Load Preview to see the prompt
              </div>
            )}
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5, margin: '10px 0 0' }}>
              Mode cycles: 📄 <strong>Full</strong> → ✂️ <strong>Local</strong> (rule-based trim, no LLM call) → ⚡ <strong>AI</strong> (LLM compresses once, cached forever). Delivery: 🧩 <strong>Chunked</strong> splits by <code>##</code> headings — the LLM waits for all sections before acting.
            </p>
          </div>

          {/* ─── Teach Agent card ──────────────────────────────────────── */}
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: 'linear-gradient(135deg, #ec4899, #f472b6)', display: 'inline-block' }} />🧑‍🏫 Teach This Agent</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              Describe a new goal or scenario. The AI will refine your goal and update the agent's guardrails — you approve before anything is saved.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <textarea className="input" rows={3}
                placeholder="e.g. When a user asks for a compliance audit, always check the latest SOC2 report first and cross-reference with internal policy docs."
                value={refineScenario} onChange={e => setRefineScenario(e.target.value)}
                disabled={agent.status !== 'ACTIVE' || refiningPrompt || applyingRefine} />

              <button
                type="button"
                className="btn btn-primary"
                disabled={!refineScenario.trim() || refiningPrompt || applyingRefine || agent.status !== 'ACTIVE'}
                onClick={() => refinePrompt(refineScenario)}
                style={{ fontWeight: 600, fontSize: 13 }}
              >
                {refiningPrompt ? '⟳ Refining...' : '✨ Refine Goal & Guardrails'}
              </button>
            </div>

            {/* Refinement preview + Approve/Reject */}
            {refineResult && (
              <div style={{ marginTop: 16, border: '1px solid var(--green)', borderRadius: 8, padding: 14, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>🔍 Review Proposed Changes</strong>
                  <button className="btn btn-secondary btn-sm" onClick={rejectRefine}>✕ Reject</button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Review below. Approve to update the agent, or reject to discard.</div>
                {refineResult.summary && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{refineResult.summary}</div>}
                {refineResult.usedFallback && (
                  <div style={{ fontSize: 11, color: 'var(--text-warning, #d97706)', fontWeight: 600 }}>⚠ fallback (model didn't return structured output)</div>
                )}
                {refineResult.guardrails?.length > 0 && (
                  <div style={{ fontSize: 12 }}>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Updated guardrails</strong>
                    <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {refineResult.guardrails.map((r: string, i: number) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}
                {refineResult.refinedGoal && (
                  <div>
                    <strong style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>✨ Refined Goal</strong>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-raised, #f8fafc)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 13, maxHeight: 120, overflowY: 'auto', lineHeight: 1.5 }}>{refineResult.refinedGoal}</div>
                  </div>
                )}
                <div>
                  <strong style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>Updated System Instructions</strong>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-raised, #f8fafc)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 13, maxHeight: 200, overflowY: 'auto', lineHeight: 1.5 }}>{refineResult.updatedSystemPrompt}</div>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                  <button
                    className="btn btn-primary"
                    onClick={approveRefine}
                    disabled={applyingRefine}
                    style={{ flex: 1, fontWeight: 700, fontSize: 13 }}
                  >
                    {applyingRefine ? '⟳ Saving...' : '✅ Approve & Save'}
                  </button>
                  <button className="btn btn-secondary" onClick={cloneFromRefine} style={{ flex: 1, fontSize: 13 }}>
                    📋 Clone as New Agent
                  </button>
                  <button className="btn btn-secondary" onClick={rejectRefine} style={{ flex: 1, fontSize: 13 }}>
                    ✕ Reject
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ─── Agent Memory card ─────────────────────────────────────── */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: 'linear-gradient(135deg, #10b981, #34d399)', display: 'inline-block' }} />🧠 Agent Memory
              </h2>
              {(agentMemory.entityMemory?.length > 0 || agentMemory.episodicMemory?.length > 0) && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: 12, color: '#ef4444' }}
                  disabled={clearingMemory}
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Clear all memory?',
                      description: `This permanently deletes ${agentMemory.entityMemory?.length || 0} fact(s) and ${agentMemory.episodicMemory?.length || 0} past experience(s) for this agent. The agent will start fresh — this cannot be undone.`,
                      confirmLabel: 'Clear All',
                      variant: 'danger',
                    })
                    if (!ok) return
                    setClearingMemory(true)
                    try {
                      await api.clearAgentMemory(tenantId, agentId)
                      setAgentMemory({ entityMemory: [], episodicMemory: [] })
                      toast('success', 'Memory cleared', 'All agent memory has been deleted.')
                    } catch { toast('error', 'Failed', 'Could not clear memory.') }
                    finally { setClearingMemory(false) }
                  }}
                >
                  {clearingMemory ? '⟳ Clearing...' : '🗑️ Clear All Memory'}
                </button>
              )}
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              What this agent remembers between tasks — facts it extracted from past runs and lessons from completed work.
              Used automatically as context on future tasks.
            </p>

            {loadingMemory ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '16px 0', textAlign: 'center' }}>⟳ Loading memory...</div>
            ) : agentMemory.entityMemory?.length === 0 && agentMemory.episodicMemory?.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0', border: '1px dashed var(--border)', borderRadius: 8 }}>
                🫙 No memory yet — facts are stored automatically after each completed task.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: 480, overflowY: 'auto', paddingRight: 6 }}>
                {agentMemory.entityMemory?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>📇 Facts &amp; Entities ({agentMemory.entityMemory.length})</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {agentMemory.entityMemory.map((m: any) => (
                        <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', background: 'var(--surface)' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, padding: '1px 7px', borderRadius: 999, background: 'rgba(16,185,129,0.15)', color: '#059669', textTransform: 'uppercase' }}>{m.entity_type}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-word' }}>{m.entity_name}</span>
                            </div>
                            {m.detail && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, wordBreak: 'break-word' }}>{m.detail}</div>}
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>seen {new Date(m.last_seen_at).toLocaleString?.() || ''}</div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ fontSize: 11, flexShrink: 0, color: '#ef4444' }}
                            disabled={deletingMemoryId === m.id}
                            onClick={async () => {
                              setDeletingMemoryId(m.id)
                              try {
                                await api.deleteAgentMemoryEntry(tenantId, agentId, m.id)
                                setAgentMemory((prev: any) => ({ ...prev, entityMemory: prev.entityMemory.filter((e: any) => e.id !== m.id) }))
                                toast('success', 'Deleted', 'Memory entry removed.')
                              } catch { toast('error', 'Failed', 'Could not delete entry.') }
                              finally { setDeletingMemoryId(null) }
                            }}
                          >
                            {deletingMemoryId === m.id ? '…' : '✕'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {agentMemory.episodicMemory?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>🎓 Past Experiences ({agentMemory.episodicMemory.length})</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {agentMemory.episodicMemory.map((m: any) => (
                        <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', background: 'var(--surface)' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, padding: '1px 7px', borderRadius: 999, background: m.outcome === 'SUCCESS' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', color: m.outcome === 'SUCCESS' ? '#34d399' : '#f87171', textTransform: 'uppercase' }}>{m.outcome || 'DONE'}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-word' }}>{m.goal_summary}</span>
                            </div>
                            {m.result_summary && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, wordBreak: 'break-word' }}>{m.result_summary}</div>}
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{new Date(m.created_at).toLocaleString?.() || ''}</div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ fontSize: 11, flexShrink: 0, color: '#ef4444' }}
                            disabled={deletingMemoryId === m.id}
                            onClick={async () => {
                              setDeletingMemoryId(m.id)
                              try {
                                await api.deleteAgentEpisodicMemoryEntry(tenantId, agentId, m.id)
                                setAgentMemory((prev: any) => ({ ...prev, episodicMemory: prev.episodicMemory.filter((e: any) => e.id !== m.id) }))
                                toast('success', 'Deleted', 'Past experience removed.')
                              } catch { toast('error', 'Failed', 'Could not delete entry.') }
                              finally { setDeletingMemoryId(null) }
                            }}
                          >
                            {deletingMemoryId === m.id ? '…' : '✕'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
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
          <div className="modal" style={{ maxWidth: 860 }}>
            <div className="modal-header">
              <h2 className="modal-title">Add Custom Skill</h2>
              <button onClick={() => { setShowSkillModal(false); setTestResult(null) }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 20, maxHeight: 'calc(90vh - 140px)', overflowY: 'auto' }}>

              {/* ── Skill Templates ──────────────────────────────────────── */}
              <div style={{ padding: 16, background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>📋 Skill Templates</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Click a template to pre-fill the form</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Send Email', type: 'nl', icon: '📧', name: 'send_email', description: 'Send an email via Gmail/ SMTP', instruction: 'Compose and send an email. Use the input to specify recipient, subject, and body. If a Gmail connector is available, use it; otherwise return the email content for manual sending.' },
                    { label: 'Slack Alert', type: 'nl', icon: '💬', name: 'slack_alert', description: 'Post a message to a Slack channel', instruction: 'Post a message to the specified Slack channel. Format the message clearly with markdown. Include relevant context from the task.' },
                    { label: 'Lookup Jira', type: 'api', icon: '🎫', name: 'lookup_jira', description: 'Fetch a Jira ticket by key', url: 'https://your-domain.atlassian.net/rest/api/3/issue/{{input.issue_key}}', method: 'GET', headers: '{\n  "Authorization": "Bearer {{config.jira_token}}"\n}' },
                    { label: 'GitHub PR', type: 'api', icon: '🐙', name: 'github_pr', description: 'Create a GitHub Pull Request', url: 'https://api.github.com/repos/{{input.owner}}/{{input.repo}}/pulls', method: 'POST', headers: '{\n  "Authorization": "Bearer {{config.github_token}}",\n  "Content-Type": "application/json"\n}', bodyTemplate: '{\n  "title": "{{input.title}}",\n  "head": "{{input.branch}}",\n  "base": "main",\n  "body": "{{input.description}}"\n}' },
                    { label: 'DB Query', type: 'nl', icon: '🗄️', name: 'db_query', description: 'Run a SQL query against a database', instruction: 'Run a SQL query. Use the database connector tool (db__*) to execute a SELECT statement. Return the results as a formatted table. Never run DDL or DML.' },
                    { label: 'Web Scraper', type: 'code', icon: '🕸️', name: 'web_scraper', description: 'Fetch and extract content from a URL', code: 'const url = input.url || "https://example.com";\nconst res = await fetch(url, {\n  headers: { "User-Agent": "Kuvalam-Agent/1.0" }\n});\nif (!res.ok) throw new Error(`HTTP ${res.status}`);\nconst html = await res.text();\n// Extract text content (strip HTML tags)\nconst text = html.replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim().slice(0, 10000);\nreturn { url, contentLength: text.length, snippet: text.slice(0, 500) };' },
                    { label: 'Gen Report', type: 'code', icon: '📊', name: 'generate_report', description: 'Generate a formatted markdown report', code: 'const title = input.title || "Report";\nconst sections = input.sections || [];\nlet report = `# ${title}\\n\\n**Generated:** ${new Date().toISOString()}\\n\\n`;\nfor (const s of sections) {\n  report += `## ${s.heading}\\n\\n${s.body}\\n\\n`;\n}\nif (input.data) {\n  report += "## Data\\n\\n";\n  report += "| Key | Value |\\n| --- | --- |\\n";\n  for (const [k, v] of Object.entries(input.data)) {\n    report += `| ${k} | ${v} |\\n`;\n  }\n  report += "\\n";\n}\nreturn { report, format: "markdown" };' },
                    { label: 'Webhook Call', type: 'api', icon: '🔔', name: 'webhook_call', description: 'Trigger a webhook with payload', url: '{{input.webhook_url}}', method: 'POST', headers: '{\n  "Content-Type": "application/json"\n}', bodyTemplate: '{\n  "event": "{{input.event}}",\n  "payload": {{input.payload}},\n  "timestamp": "{{$now}}"\n}' },
                    { label: 'Transform JSON', type: 'code', icon: '🔄', name: 'transform_data', description: 'Transform JSON data with a mapping', code: 'const data = input.data || {};\nconst mapping = input.mapping || {};\nconst result = {};\nfor (const [key, path] of Object.entries(mapping)) {\n  const value = path.split(".").reduce((obj, k) => obj?.[k], data);\n  result[key] = value ?? null;\n}\nreturn { original: data, transformed: result };' },
                    { label: 'Python Analysis', type: 'code', icon: '🐍', name: 'data_analysis', description: 'Analyse data with Python (pandas)', code: 'def run(input):\n    import json\n    data = input.get("data", [])\n    field = input.get("field", "value")\n    values = [d.get(field, 0) for d in data if isinstance(d, dict)]\n    return {\n        "count": len(values),\n        "sum": sum(values),\n        "avg": sum(values) / len(values) if values else 0,\n        "min": min(values) if values else 0,\n        "max": max(values) if values else 0\n    }', language: 'python' },
                  ].map(tpl => (
                    <button
                      key={tpl.label}
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => {
                        setNewSkill({
                          type: tpl.type as 'nl' | 'api' | 'code',
                          name: tpl.name,
                          description: tpl.description,
                          instruction: (tpl as any).instruction || '',
                          code: (tpl as any).code || '',
                          url: (tpl as any).url || '',
                          method: (tpl as any).method || 'GET',
                          headers: (tpl as any).headers || '{\n  "Content-Type": "application/json"\n}',
                          bodyTemplate: (tpl as any).bodyTemplate || '',
                          language: (tpl as any).language || 'javascript',
                        });
                        toast('info', `Template "${tpl.label}" applied`, 'Review and customise before saving.');
                      }}
                    >
                      {tpl.icon} {tpl.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Skill Type Tabs ──────────────────────────────────────────── */}
              <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
                <button 
                  type="button"
                  className={`btn ${newSkill.type === 'nl' ? 'btn-primary' : 'btn-secondary'}`} 
                  onClick={() => setNewSkill({ ...newSkill, type: 'nl' })}
                >
                  📝 Natural Language
                </button>
                <button 
                  type="button"
                  className={`btn ${newSkill.type === 'api' ? 'btn-primary' : 'btn-secondary'}`} 
                  onClick={() => setNewSkill({ ...newSkill, type: 'api' })}
                >
                  🔗 API Endpoint
                </button>
                <button 
                  type="button"
                  className={`btn ${newSkill.type === 'code' && newSkill.language === 'javascript' ? 'btn-primary' : 'btn-secondary'}`} 
                  onClick={() => setNewSkill({ ...newSkill, type: 'code', language: 'javascript' })}
                >
                  ⚡ JS Script
                </button>
                <button 
                  type="button"
                  className={`btn ${newSkill.type === 'code' && newSkill.language === 'python' ? 'btn-primary' : 'btn-secondary'}`} 
                  onClick={() => setNewSkill({ ...newSkill, type: 'code', language: 'python' })}
                >
                  🐍 Python Script
                </button>
              </div>

              {/* ── AI Generate Skill ────────────────────────────────────── */}
              <div style={{ padding: 16, background: 'linear-gradient(135deg, rgba(139,92,246,0.08), rgba(59,130,246,0.08))', borderRadius: 10, border: '1px solid rgba(139,92,246,0.25)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 18 }}>✨</span>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>AI Generate</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Describe what you need and AI will fill in the form</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <textarea
                      className="input"
                      rows={2}
                      value={skillPrompt}
                      onChange={e => setSkillPrompt(e.target.value)}
                      placeholder={
                        newSkill.type === 'nl'
                          ? 'e.g. Search the CRM for a customer by email, then send them a follow-up'
                          : newSkill.type === 'api'
                          ? 'e.g. Look up a GitHub user profile and return their public repos'
                          : 'e.g. Fetch stock price data and calculate the 7-day moving average'
                      }
                      style={{ fontSize: 13, resize: 'vertical' }}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      if (!skillPrompt.trim() || skillPrompt.trim().length < 10) {
                        toast('error', 'Too short', 'Please describe the skill in at least 10 characters.')
                        return
                      }
                      setGeneratingSkill(true)
                      try {
                        const res = await api.generateSkill(tenantId, {
                          prompt: skillPrompt.trim(),
                          skillType: newSkill.type,
                          language: newSkill.language as 'javascript' | 'python',
                        })
                        const data = res.data || res
                        // Pre-fill the form with AI-generated values
                        setNewSkill(prev => ({
                          ...prev,
                          name: data.name || prev.name,
                          description: data.description || prev.description,
                          instruction: data.instruction || prev.instruction,
                          code: data.code || prev.code,
                          url: data.url || prev.url,
                          method: data.method || prev.method,
                          headers: typeof data.headers === 'object' ? JSON.stringify(data.headers, null, 2) : (data.headers || prev.headers),
                          bodyTemplate: typeof data.bodyTemplate === 'object' ? JSON.stringify(data.bodyTemplate, null, 2) : (data.bodyTemplate || prev.bodyTemplate),
                          language: data.language || prev.language,
                        }))
                        setSkillPrompt('')
                        toast('success', 'Skill generated!', 'Review the fields and save when ready.')
                      } catch (err: any) {
                        toast('error', 'Generation failed', err.message || 'Please try again.')
                      } finally {
                        setGeneratingSkill(false)
                      }
                    }}
                    disabled={generatingSkill || !skillPrompt.trim()}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {generatingSkill ? '⏳ Generating...' : '✨ Generate'}
                  </button>
                </div>
              </div>

              <form onSubmit={saveSkill} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* ── Name & Description ──────────────────────────────────── */}
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div className="form-group">
                      <label className="form-label">Skill Name <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(snake_case, e.g. search_crm)</span></label>
                      <input className="input" value={newSkill.name} onChange={e => setNewSkill({ ...newSkill, name: e.target.value.replace(/\s+/g, '_') })} required placeholder="e.g. search_crm" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Description <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(tell the AI *when* to use this)</span></label>
                      <input className="input" value={newSkill.description} onChange={e => setNewSkill({ ...newSkill, description: e.target.value })} required placeholder="e.g. Search the CRM for a customer by email" />
                    </div>
                  </div>
                </div>
              
                {newSkill.type === 'nl' ? (
                  <div className="card" style={{ padding: 16 }}>
                    <div className="form-group">
                      <label className="form-label">🧠 Instructions (Plain English)</label>
                      <textarea 
                        className="input" 
                        rows={6} 
                        value={newSkill.instruction} 
                        onChange={e => setNewSkill({ ...newSkill, instruction: e.target.value })} 
                        placeholder="Describe exactly what the agent should do when using this skill. e.g. 'To generate a report, first fetch the sales data from the database, then format it as a markdown table with columns for date, revenue, and growth rate.'" 
                        required={newSkill.type === 'nl'}
                        style={{ fontSize: 13, lineHeight: 1.6 }}
                      />
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, padding: '8px 12px', background: 'var(--surface)', borderRadius: 6, border: '1px dashed var(--border)' }}>
                        💡 <strong>Tip:</strong> The agent reads these instructions and spawns a sub-agent to execute them. Be specific about steps, data sources, and expected output format.
                      </p>
                    </div>
                  </div>
                ) : newSkill.type === 'api' ? (
                  <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Use <code>{'{{input.parameter}}'}</code> for dynamic arguments and <code>{'{{config.key}}'}</code> for connector secrets.</p>
                      </div>
                    </div>
                    
                    <div className="form-group">
                      <label className="form-label">Headers <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(JSON)</span></label>
                      <textarea className="input" rows={3} style={{ fontFamily: 'monospace', fontSize: 12 }} value={newSkill.headers} onChange={e => setNewSkill({ ...newSkill, headers: e.target.value })} />
                    </div>
                    
                    {['POST', 'PUT', 'PATCH'].includes(newSkill.method) && (
                      <div className="form-group">
                        <label className="form-label">Body Template <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(JSON)</span></label>
                        <textarea className="input" rows={4} style={{ fontFamily: 'monospace', fontSize: 12 }} value={newSkill.bodyTemplate} onChange={e => setNewSkill({ ...newSkill, bodyTemplate: e.target.value })} placeholder={'{\n  "query": "{{input.query}}"\n}'} />
                      </div>
                    )}
                  </div>
                ) : newSkill.type === 'code' && newSkill.language === 'python' ? (
                  <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div className="form-group">
                      <label className="form-label">🐍 Python Script</label>
                      <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                        <textarea
                          className="input"
                          rows={12}
                          value={newSkill.code}
                          onChange={e => setNewSkill({ ...newSkill, code: e.target.value })}
                          placeholder={`def run(input):\n    # input is a dict with task arguments\n    query = input.get("query", "")\n    result = {"message": f"Query was: {query}"}\n    return result`}
                          style={{ fontFamily: '"Fira Code", "JetBrains Mono", monospace', fontSize: 13, minHeight: 220, background: '#1d1f21', color: '#c5c8c6' }}
                        />
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, padding: '8px 12px', background: 'var(--surface)', borderRadius: 6, border: '1px dashed var(--border)' }}>
                        🐍 <strong>Tip:</strong> Define a <code>run(input)</code> function that returns a dict. Use <code>input</code> for arguments. Example: <code>{'def run(input):\n    return {"sum": input["a"] + input["b"]}'}</code>
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div className="form-group">
                      <label className="form-label">⚡ JavaScript Sandbox Script</label>
                      <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
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
                            minHeight: 220
                          }}
                          textareaClassName="code-editor-textarea"
                        />
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, padding: '8px 12px', background: 'var(--surface)', borderRadius: 6, border: '1px dashed var(--border)' }}>
                        💡 <strong>Tip:</strong> Use <code>input</code> for arguments. Return a value or object. <code>fetch()</code> is available globally. Example: <code>{"const res = await fetch(`https://api.example.com/data?q=${input.query}`); return await res.json();"}</code>
                      </p>
                    </div>

                    {/* Test Panel */}
                    <div className="card" style={{ padding: 16, background: 'var(--surface)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                        <div className="form-group" style={{ flex: 1, margin: 0 }}>
                          <label className="form-label" style={{ fontSize: 12 }}>🧪 Test Input <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(JSON)</span></label>
                          <textarea 
                            className="input" 
                            rows={3} 
                            style={{ fontFamily: 'monospace', fontSize: 12 }}
                            value={testInput} 
                            onChange={e => setTestInput(e.target.value)} 
                            placeholder='{"query": "example"}'
                          />
                        </div>
                        <button type="button" className="btn btn-secondary" onClick={testSkill} disabled={isTesting || !newSkill.code} style={{ marginTop: 24, whiteSpace: 'nowrap' }}>
                          {isTesting ? '⏳ Running...' : '▶ Test Skill'}
                        </button>
                      </div>
                      
                      {testResult && (
                        <div style={{ marginTop: 12, padding: 12, borderRadius: 6, background: '#0f1117', borderLeft: `3px solid ${testResult.success ? '#22c55e' : '#ef4444'}` }}>
                          <div style={{ color: testResult.success ? '#22c55e' : '#ef4444', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>
                            {testResult.success ? '✓ Success' : '✗ Error'}
                          </div>
                          <pre style={{ margin: 0, color: '#e2e8f0', fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 150, overflowY: 'auto' }}>
                            {testResult.success ? JSON.stringify(testResult.data, null, 2) : testResult.error}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </form>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => {
                setShowSkillModal(false); setTestResult(null)
              }}>Cancel</button>
              <button type="submit" className="btn btn-primary" onClick={saveSkill} disabled={!newSkill.name || (newSkill.type === 'api' ? !newSkill.url : newSkill.type === 'nl' ? !newSkill.instruction : !newSkill.code)}>💾 Save Skill</button>
            </div>
          </div>
        </div>
      )}
      {/* Clone Agent Modal */}
      {cloneModalOpen && (
        <div className="modal-overlay" onClick={() => setCloneModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: 16 }}>📋 Clone as New Agent</h3>
            </div>
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                This will create a new agent with the refined system instructions and goal.
                The current agent will not be modified.
              </p>
              <div className="form-group">
                <label className="form-label">New Agent Name</label>
                <input
                  className="input"
                  value={cloneName}
                  onChange={e => setCloneName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') confirmCloneAgent() }}
                  autoFocus
                  maxLength={80}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setCloneModalOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmCloneAgent} disabled={!cloneName.trim() || cloningAgent}>
                {cloningAgent ? '⟳ Creating...' : 'Create Agent'}
              </button>
            </div>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
    </div>
  )
}
