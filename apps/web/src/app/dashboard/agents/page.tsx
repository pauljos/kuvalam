'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import Link from 'next/link'
import { useConfirm } from '@/components/ConfirmModal'

const ARCHETYPES = ['Planner', 'Research', 'Compliance', 'Document', 'Communication', 'Analytics', 'Coordinator', 'Data-Entry', 'Developer', 'Agent-Generation']

const PROMPT_TEMPLATES = [
  { label: 'Data Analyst', name: 'Data Analyst', description: 'Analyzes provided datasets, computes key metrics, and generates summary reports.', archetype: 'analytics', prompt: 'You are an expert Data Analyst agent. Your goal is to analyze provided datasets, compute key metrics, identify trends, and generate comprehensive summary reports.\n\nRULES:\n1. Always verify data formatting before processing.\n2. Summarize key findings in clear markdown tables.\n3. Do not hallucinate data.' },
  { label: 'Software Engineer', name: 'Software Engineer', description: 'Autonomous software engineering agent that writes clean, maintainable code.', archetype: 'coordinator', prompt: 'You are an autonomous Software Engineering agent. Your role is to write clean, maintainable, and efficient code.\n\nRULES:\n1. Plan your architecture before writing code.\n2. Always include basic test coverage for logic.\n3. Ensure code conforms to modern linting standards.' },
  { label: 'Research Assistant', name: 'Research Assistant', description: 'Gathers information, synthesizes long documents, and provides cited summaries.', archetype: 'research', prompt: 'You are a meticulous Research Assistant. Your role is to gather information, synthesize long documents, and provide accurate, cited summaries.\n\nRULES:\n1. Extract key facts and list them as bullet points.\n2. Do not invent information.\n3. When asked to summarize, maintain the original tone.' },
  { label: 'Customer Support', name: 'Customer Support', description: 'Polite and empathetic agent for resolving user issues efficiently.', archetype: 'communication', prompt: 'You are a polite and empathetic Customer Support agent. Your role is to resolve user issues efficiently while maintaining a professional tone.\n\nRULES:\n1. Always start by acknowledging the user\'s frustration or issue.\n2. Provide step-by-step solutions.\n3. Escalate to a human if the issue cannot be resolved.' },
  { label: 'Analytical Agent', name: 'Analytical Agent', description: 'Advanced analytics agent that identifies complex patterns and performs predictive modeling.', archetype: 'analytics', prompt: 'You are a sophisticated Analytical Agent. Your objective is to dive deep into complex datasets, uncover hidden patterns, perform predictive modeling, and provide actionable business intelligence.\n\nRULES:\n1. Use statistical methods to validate your findings.\n2. Present data visualizations and interpretations clearly.\n3. Highlight anomalies or edge cases in the data.' },
  { label: 'Project Manager', name: 'Project Manager', description: 'Coordinates tasks, tracks project progress, and ensures timely delivery.', archetype: 'planner', prompt: 'You are an organized Project Management agent. Your role is to coordinate tasks, allocate resources, track project milestones, and ensure deliverables are met on time.\n\nRULES:\n1. Break down large goals into actionable tasks.\n2. Monitor progress and flag potential bottlenecks early.\n3. Maintain clear and concise communication with all stakeholders.' },
  { label: 'Compliance Officer', name: 'Compliance Officer', description: 'Ensures documents and processes adhere to regulatory and organizational standards.', archetype: 'compliance', prompt: 'You are a strict Compliance agent. Your role is to review documents, code, or processes to ensure they meet all legal, regulatory, and organizational standards.\n\nRULES:\n1. Cross-reference all claims against official guidelines.\n2. Flag any violations or risky language immediately.\n3. Provide specific suggestions for remediation.' },
  { label: 'Content Strategist', name: 'Content Strategist', description: 'Plans, creates, and optimizes content strategies for maximum engagement.', archetype: 'document', prompt: 'You are a creative Content Strategist agent. Your role is to plan, create, and optimize content for maximum audience engagement and brand consistency.\n\nRULES:\n1. Align all content with the target audience and brand voice.\n2. Optimize for readability and SEO where applicable.\n3. Provide structured outlines before drafting long-form content.' },
  { label: 'Data Entry Specialist', name: 'Data Entry Specialist', description: 'Navigates web pages and performs automated data entry and extraction.', archetype: 'data-entry', prompt: 'You are a Browser Automation Agent. Your role is to use the browser_use tool to navigate to URLs, interact with web elements, and perform data entry or extraction.\n\nCRITICAL: You MUST call the browser_use tool to interact with web pages. Do NOT describe what you would do — execute the tool.\n\nTool usage:\n- browser_use with action="navigate", url="..." — opens a page\n- browser_use with action="click", selector="..." — clicks an element\n- browser_use with action="type", selector="...", text="..." — types into a field\n- browser_use with action="extract", selector="..." — gets text from elements\n- browser_use with action="screenshot" — takes a screenshot\n\nRULES:\n1. Always navigate to the URL first, then wait for the page to load.\n2. Use CSS selectors to identify elements (e.g. "#search-box", ".btn-primary", "form input[name=email]").\n3. Handle timeouts gracefully — if something fails, report what happened.\n4. After completing the task, summarize what was done.' },
  { label: 'Database Analyst', name: 'Database Analyst', description: 'Explores databases, writes SQL queries, and answers questions about your data.', archetype: 'analytics', prompt: 'You are a Database Analyst agent. Your role is to explore connected databases, write SQL queries, and answer questions about the data by EXECUTING database tools.\n\n⚠️ CRITICAL: You MUST call the database tools to get real data. DO NOT describe what you will do. DO NOT write a plan. DO NOT explain your approach. Instead, IMMEDIATELY call the tools:\n\n1. First call `list_tables` to see what tables exist.\n2. Then call `describe_table` on the most relevant table(s).\n3. Then call `query` with a SQL statement to get the actual data.\n\nExample correct flow:\n  list_tables() → get result\n  describe_table("customers") → get result\n  query("SELECT country, COUNT(*) FROM customers GROUP BY country ORDER BY COUNT(*) DESC LIMIT 10") → get result\n  THEN present the findings in a table.\n\nRULES:\n1. CALL THE TOOLS — do not skip them, do not describe them.\n2. Write correct SQL with JOINs, WHERE, GROUP BY as needed.\n3. For "top"/"best"/"most" — ORDER BY DESC and LIMIT.\n4. Cap results: 20 rows max for listings, 10 for rankings.\n5. After tools return data, present it in a clean markdown table.\n6. If no results, suggest why (empty table, wrong filter).\n7. Read-only — never modify data.\n8. NEVER hallucinate data — only report what the tools returned.\n9. After presenting data, call publish_dashboard_report once with the full HTML report.' },
  { label: 'Developer Agent', name: 'Developer Agent', description: 'Writes, reviews, and debugs code with tool-assisted execution and testing.', archetype: 'developer', prompt: 'You are an expert Developer Agent. Your role is to write clean, secure, and well-tested code across multiple languages and frameworks.\n\nRULES:\n1. Plan your approach before writing code — outline the architecture first.\n2. Write modular, reusable code with clear function names and comments.\n3. Handle errors gracefully with proper validation and fallbacks.\n4. Include unit tests for all critical logic paths.\n5. Use modern language features and idioms — avoid deprecated patterns.\n6. When debugging, isolate the issue and explain your fix clearly.\n7. Document any assumptions or limitations in your solution.' },
  { label: 'Agent Generator', name: 'Agent Generator', description: 'Meta-agent that designs, configures, and creates other AI agents from descriptions.', archetype: 'agent-generation', prompt: 'You are a meta Agent Generation agent. Your role is to analyze user requirements and create new AI agents with the right archetype, tools, and system prompts.\n\nRULES:\n1. First understand the user\'s goal — what should the new agent accomplish?\n2. Choose the most appropriate archetype from: data-analyst, research, coordinator, agent-generation, customer-support, planner, compliance, document, developer, data-entry.\n3. Define the necessary tools (built_in or custom) the agent needs.\n4. Write a clear, actionable system prompt with explicit RULES and tool-calling instructions.\n5. Set autonomy level based on risk: SUPERVISED for high-stakes, GUARDED for moderate, AUTONOMOUS for safe/repetitive tasks.\n6. Name the agent descriptively so its purpose is clear at a glance.' }
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

const ARCHETYPE_ICONS: Record<string, string> = {
  planner: '📋', research: '🔬', compliance: '🛡️', document: '📄',
  communication: '💬', analytics: '📊', 'data-analyst': '📊', coordinator: '⚙️', data: '🗄️',
  developer: '💻', support: '🎧', 'data-entry': '🌐', 'agent-generation': '🏭',
  'customer-support': '🎧',
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
  const [searchQuery, setSearchQuery] = useState('')
  const [genPrompt, setGenPrompt] = useState('')
  const [generatingAgent, setGeneratingAgent] = useState(false)
  const [genError, setGenError] = useState('')

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

  async function generateAgent() {
    if (!genPrompt.trim() || generatingAgent) return
    setGeneratingAgent(true)
    setGenError('')
    try {
      const result = await api.generateAgentFromPrompt(tenantId, genPrompt.trim())
      setForm(f => ({
        ...f,
        name: result.name || f.name,
        description: result.description || f.description,
        archetype: result.archetype || f.archetype,
        systemPrompt: result.systemPrompt || f.systemPrompt,
        autonomyLevel: result.autonomyLevel || f.autonomyLevel,
      }))
      toast('success', 'Agent generated!', 'Review and adjust the fields below, then click Create Agent.')
    } catch (err: any) {
      setGenError(err.message || 'Failed to generate agent. Try rephrasing your prompt.')
    } finally {
      setGeneratingAgent(false)
    }
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

        {agents.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <input
              className="input"
              placeholder="Search agents by name, description, or provider..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ maxWidth: 400, padding: '10px 14px' }}
            />
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
          <div>
            {(() => {
              const filtered = searchQuery
                ? agents.filter(a =>
                    a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    (a.description || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                    (a.llm_provider || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                    (a.llm_model || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                    a.autonomy_level?.toLowerCase().includes(searchQuery.toLowerCase())
                  )
                : agents
              if (filtered.length === 0) {
                return (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: 28, marginBottom: 10 }}>🔍</div>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>No agents match &ldquo;{searchQuery}&rdquo;</div>
                    <div style={{ fontSize: 13 }}>Try a different search term.</div>
                  </div>
                )
              }
              return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                  {filtered.map(agent => {
                    const archetype = (agent.archetype || '').toLowerCase()
                    const archetypeIcon = ARCHETYPE_ICONS[archetype] || '⚡'
                    const statusColor = agent.status === 'ACTIVE' ? 'var(--green)' : agent.status === 'DRAFT' ? '#f59e0b' : '#ef4444'
                    const statusBg = agent.status === 'ACTIVE' ? '#d1fae5' : agent.status === 'DRAFT' ? '#fef3c7' : '#fecaca'
                    const statusText = agent.status === 'ACTIVE' ? '#065f46' : agent.status === 'DRAFT' ? '#92400e' : '#991b1b'
                    const hasSkills = (agent.skills?.length || 0) > 0 || (agent.system_prompt?.length || 0) > 50
                    return (
              <div key={agent.id} className="card card-hover" style={{
                padding: 22, display: 'flex', flexDirection: 'column', gap: 14,
                border: agent.status === 'ACTIVE' ? '1px solid var(--green-border)' : '1px solid var(--border)',
              }}>
                {/* Top row: icon + name + status */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                    background: agent.status === 'ACTIVE' ? '#d1fae5' : '#f3f4f6',
                    border: `2px solid ${agent.status === 'ACTIVE' ? 'var(--green-border)' : 'var(--border)'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
                  }}>
                    {archetypeIcon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <h3 style={{ fontWeight: 700, fontSize: 15, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</h3>
                    </div>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {agent.description || 'No description'}
                    </p>
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                    background: statusBg, color: statusText, whiteSpace: 'nowrap', flexShrink: 0,
                    border: `1px solid ${statusColor}33`,
                  }}>
                    {agent.status === 'ACTIVE' ? '● Live' : agent.status === 'DRAFT' ? '○ Draft' : agent.status}
                  </span>
                </div>

                {/* Info chips */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                    background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}>
                    🧠 {PROVIDER_LABELS[agent.llm_provider]?.replace(/ \(.*\)$/, '') || agent.llm_provider}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                    background: '#f5f3ff', color: '#5b21b6', border: '1px solid #ddd6fe',
                  }}>
                    {agent.llm_model}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                    background: agent.autonomy_level === 'AUTONOMOUS' ? '#fef2f2' : agent.autonomy_level === 'GUARDED' ? '#fffbeb' : '#f0fdf4',
                    color: agent.autonomy_level === 'AUTONOMOUS' ? '#991b1b' : agent.autonomy_level === 'GUARDED' ? '#92400e' : '#166534',
                    border: `1px solid ${agent.autonomy_level === 'AUTONOMOUS' ? '#fecaca' : agent.autonomy_level === 'GUARDED' ? '#fde68a' : '#bbf7d0'}`,
                    textTransform: 'capitalize',
                  }}>
                    {agent.autonomy_level === 'AUTONOMOUS' ? '🚀' : agent.autonomy_level === 'GUARDED' ? '🛡️' : '🔒'} {agent.autonomy_level?.toLowerCase()}
                  </span>
                  {archetype && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                      background: '#eff6ff', color: '#1e40af', border: '1px solid #bfdbfe',
                      textTransform: 'capitalize',
                    }}>
                      {archetypeIcon} {archetype}
                    </span>
                  )}
                  {hasSkills && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                      background: '#fefce8', color: '#854d0e', border: '1px solid #fef08a',
                    }}>
                      ✨ Custom skills
                    </span>
                  )}
                </div>

                {/* System prompt preview (if any) */}
                {agent.system_prompt && (
                  <div style={{
                    fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4,
                    padding: '8px 10px', background: '#f9fafb', borderRadius: 6,
                    border: '1px dashed var(--border)', fontFamily: 'monospace',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {agent.system_prompt.slice(0, 100)}{agent.system_prompt.length > 100 ? '…' : ''}
                  </div>
                )}

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                  <Link href={`/dashboard/agents/${agent.id}`} className="btn btn-secondary btn-sm" style={{ flex: 1, textDecoration: 'none', textAlign: 'center' }}>Configure</Link>
                  {agent.status === 'DRAFT' && (
                    <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => activate(agent.id)}>Activate</button>
                  )}
                  {agent.status === 'ACTIVE' && (
                    <Link href={`/dashboard/agents/${agent.id}`} className="btn btn-primary btn-sm" style={{ flex: 1, textDecoration: 'none', textAlign: 'center' }}>Run Task</Link>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => duplicate(agent.id)} title="Duplicate agent" style={{ padding: '0 10px' }}>📋</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => deleteAgent(agent.id)} title="Delete agent" style={{ padding: '0 10px', color: 'var(--red)' }}>🗑</button>
                </div>
              </div>
            )})}
                </div>
              )
            })()}
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
                {/* AI Agent Generator */}
                <div className="form-group" style={{ marginBottom: 4, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
                  <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    ✨ Describe Your Agent (AI Generator)
                  </label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <textarea
                      className="input"
                      placeholder='Describe what the agent should do… e.g. "An agent that monitors Jira for overdue tickets every morning and sends a Slack alert to the engineering channel"'
                      value={genPrompt}
                      onChange={e => { setGenPrompt(e.target.value); setGenError('') }}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generateAgent() }}
                      rows={3}
                      style={{ flex: 1, resize: 'vertical', fontSize: 13 }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={generateAgent}
                      disabled={generatingAgent || !genPrompt.trim()}
                      style={{ alignSelf: 'flex-end', whiteSpace: 'nowrap' }}
                    >
                      {generatingAgent ? '⟳ Generating…' : 'Generate'}
                    </button>
                  </div>
                  {genError && (
                    <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{genError}</div>
                  )}
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Describe your needs and AI will fill in the form below. Review before creating.
                  </p>
                </div>

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
                      <option value="GUARDED">Guarded</option>
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
