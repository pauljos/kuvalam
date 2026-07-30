'use client'
import { useEffect, useState, useCallback } from 'react'
import { api, API } from '@/lib/api'
import { useApp } from '@/lib/context'
import { useConfirm } from '@/components/ConfirmModal'
import { Shield } from 'lucide-react'

const PROVIDERS: Array<{
  id: string
  name: string
  icon: string
  color: string
  models: string[]
  keyLabel: string
  keyPlaceholder: string
  baseUrl: string | null
  kind?: 'local'
  description?: string
}> = [
  { id: 'openai', name: 'OpenAI', icon: '🤖', color: '#10a37f', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'], keyLabel: 'API Key', keyPlaceholder: 'sk-...', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', icon: '🧠', color: '#c07000', models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'], keyLabel: 'API Key', keyPlaceholder: 'sk-ant-...', baseUrl: null },
  { id: 'openrouter', name: 'OpenRouter', icon: '🔀', color: '#6366f1', models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-pro-1.5', 'meta-llama/llama-3.1-70b-instruct', 'mistralai/mistral-large'], keyLabel: 'API Key', keyPlaceholder: 'sk-or-v1-...', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'opencode', name: 'OpenCode', icon: '💻', color: '#10b981', models: ['deepseek-v4-pro', 'minimax-m3', 'qwen3.7-max', 'mimo-v2-pro'], keyLabel: 'API Key', keyPlaceholder: 'sk-...', baseUrl: 'https://opencode.ai/zen/go/v1' },
  { id: 'deepseek', name: 'DeepSeek', icon: '🔍', color: '#4f46e5', models: ['deepseek-chat', 'deepseek-reasoner'], keyLabel: 'API Key', keyPlaceholder: 'sk-...', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'kimi', name: 'Kimi (Moonshot)', icon: '🌙', color: '#8b5cf6', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-auto'], keyLabel: 'API Key', keyPlaceholder: 'sk-...', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'groq', name: 'Groq (Fast)', icon: '⚡', color: '#f59e0b', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'], keyLabel: 'API Key', keyPlaceholder: 'gsk_...', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', name: 'Mistral AI', icon: '🌊', color: '#3b82f6', models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'], keyLabel: 'API Key', keyPlaceholder: 'your-mistral-key', baseUrl: 'https://api.mistral.ai/v1' },
  // ── Local / self-hosted OpenAI-compatible servers ──────────────────────────
  { id: 'ollama', name: 'Ollama (Local)', icon: '🦙', color: '#3f8a43', kind: 'local', models: ['llama3.2', 'llama3.1', 'mistral', 'gemma2', 'phi3', 'qwen2.5', 'deepseek-r1'], keyLabel: 'Base URL', keyPlaceholder: 'http://localhost:11434/v1', baseUrl: 'http://localhost:11434/v1', description: 'Run open models on your own machine with Ollama. No API key required.' },
  { id: 'lmstudio', name: 'LM Studio (Local)', icon: '🖥️', color: '#3f8a43', kind: 'local', models: ['local-model'], keyLabel: 'Base URL', keyPlaceholder: 'http://localhost:1234/v1', baseUrl: 'http://localhost:1234/v1', description: 'Uses LM Studio\u2019s built-in OpenAI-compatible server (enable it in the Server tab).' },
  { id: 'localai', name: 'LocalAI (Local)', icon: '🏠', color: '#3f8a43', kind: 'local', models: ['gpt-3.5-turbo', 'ggml-gpt4all-j'], keyLabel: 'Base URL', keyPlaceholder: 'http://localhost:8080/v1', baseUrl: 'http://localhost:8080/v1', description: 'Self-hosted, OpenAI-compatible inference server.' },
  { id: 'custom', name: 'Custom OpenAI-Compatible', icon: '🛠️', color: '#3f8a43', kind: 'local', models: ['gpt-4o-mini', 'gpt-4o', 'Meta-Llama-3-70B', 'Mistral-7B', 'deepseek-coder-6.7b', 'Qwen-14B'], keyLabel: 'Base URL', keyPlaceholder: 'https://your-server/v1', baseUrl: '', description: 'Point at any OpenAI-compatible endpoint (vLLM, llama.cpp, TGI, Together, Fireworks, etc.).' },
]

function ProviderCard({ provider, config, tenantId, onSaved, toast }: any) {
  const { confirm, ConfirmDialog } = useConfirm()
  const [open, setOpen] = useState(false)
  const isLocal = provider.kind === 'local'
  const [form, setForm] = useState({
    apiKey: '',
    model: config?.model || provider.models[0] || '',
    baseUrl: config?.baseUrl || provider.baseUrl || ''
  })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [dynamicModels, setDynamicModels] = useState<string[]>([])
  const [removing, setRemoving] = useState(false)

  const isConfigured = !!config
  const set = (k: string) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }))

  // Auto-fetch models when a local provider card opens
  useEffect(() => {
    if (!open || !isLocal || !provider.id) return
    let cancelled = false
    ;(async () => {
      try {
        const baseUrl = form.baseUrl || provider.baseUrl
        if (!baseUrl) return
        const result = await api.testLLMProvider(tenantId, { provider: provider.id, baseUrl, model: form.model || provider.models[0] })
        if (!cancelled && result?.models?.length > 0) {
          setDynamicModels(result.models)
        }
      } catch {}
    })()
    return () => { cancelled = true }
  }, [open, provider.id])

  async function save(e: any) {
    e.preventDefault(); setSaving(true); setTestResult(null)
    try {
      const body: any = { provider: provider.id, model: form.model }
      if (isLocal) {
        // Local providers: no API key required, base URL is the primary field
        body.baseUrl = form.baseUrl || provider.baseUrl
        if (form.apiKey) body.apiKey = form.apiKey // optional bearer for gated servers
      } else {
        body.apiKey = form.apiKey
        body.baseUrl = form.baseUrl || provider.baseUrl
      }
      if (!body.model) throw new Error('Model name is required')
      if (isLocal && !body.baseUrl) throw new Error('Base URL is required for local providers')
      const result = await api.saveLLMConfig(tenantId, body)
      // Use the returned config directly to avoid a stale GET round-trip
      if (result?.llm_config) {
        onSaved(result.llm_config)
      } else {
        onSaved()
      }
      setOpen(false); setForm(f => ({ ...f, apiKey: '' }))
      toast('success', `${provider.name} configured`, 'Model provider is now active.')
    } catch (err: any) { toast('error', 'Save failed', err.message) } finally { setSaving(false) }
  }

  async function test() {
    setTesting(true); setTestResult(null)
    try {
      const body: any = { provider: provider.id, model: form.model || config?.model }
      if (isLocal) {
        body.baseUrl = form.baseUrl || config?.baseUrl || provider.baseUrl
        if (form.apiKey) body.apiKey = form.apiKey
      } else {
        body.apiKey = form.apiKey || '(saved)'
        body.baseUrl = form.baseUrl || provider.baseUrl
      }
      const result = await api.testLLMProvider(tenantId, body)
      setTestResult(result)
      if (result.models?.length > 0) {
        setDynamicModels(result.models)
        if (!result.models.includes(form.model)) {
          setForm(f => ({ ...f, model: result.models[0] }))
        }
      }
    } catch (err: any) { setTestResult({ success: false, message: err.message }) } finally { setTesting(false) }
  }

  async function remove() {
    const ok = await confirm({
      title: `Remove ${provider.name}?`,
      description: 'Agents using this provider will fail on their next run. You can add it back later.',
      confirmLabel: 'Remove provider',
      variant: 'danger',
    })
    if (!ok) return
    setRemoving(true)
    try {
      const result = await api.removeLLMProvider(tenantId, provider.id)
      if (result?.llm_config) {
        onSaved(result.llm_config)
      } else {
        onSaved()
      }
      toast('info', `${provider.name} removed`, '')
    } catch (err: any) { toast('error', 'Remove failed', err.message) } finally { setRemoving(false) }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', border: isConfigured ? `1px solid ${provider.color}30` : undefined }}>
      {/* Header */}
      <div style={{ padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: `${provider.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, border: `1px solid ${provider.color}25` }}>{provider.icon}</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{provider.name}</div>
            {isConfigured ? (
              <div style={{ fontSize: 12, color: '#10b981', marginTop: 2 }}>✓ Configured · {config.model}</div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Not configured</div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isConfigured && <span style={{ fontSize: 12, padding: '3px 10px', background: '#10b98118', color: '#10b981', borderRadius: 20, border: '1px solid #10b98130' }}>Active</span>}
          <button className="btn btn-secondary btn-sm" onClick={() => setOpen(!open)}>
            {open ? 'Close' : isConfigured ? 'Edit' : 'Configure'}
          </button>
        </div>
      </div>

      {/* Expand */}
      {open && (
        <form onSubmit={save} style={{ padding: '0 20px 20px', borderTop: '1px solid var(--border)' }}>
          <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {isLocal && provider.description && (
              <p className="form-hint" style={{ marginTop: 0 }}>{provider.description}</p>
            )}

            {/* Base URL — always shown for local providers, optional for cloud */}
            {provider.baseUrl !== null && (
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                  Base URL
                </label>
                <input className="input" type="url" placeholder={provider.keyPlaceholder} value={form.baseUrl} onChange={set('baseUrl')} required={!isConfigured} />
                <p className="form-hint">The API endpoint to use. Leave as default unless using a proxy.</p>
              </div>
            )}

            {/* API key — required for cloud, optional for local */}
            {!isLocal ? (
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                  {provider.keyLabel}
                </label>
                <input className="input" type="password" placeholder={provider.keyPlaceholder} value={form.apiKey} onChange={set('apiKey')} required={!isConfigured} />
                {isConfigured ? (
                  <p className="form-hint">Current key: {config.apiKey} — leave blank to keep existing.</p>
                ) : (
                  <p className="form-hint">🔒 Encrypted at rest. Get your key from the {provider.name} dashboard.</p>
                )}
              </div>
            ) : (
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                  API Key <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
                </label>
                <input className="input" type="password" placeholder="Leave blank if not required" value={form.apiKey} onChange={set('apiKey')} />
                <p className="form-hint">Most local servers don&apos;t need a key. Set one only if your endpoint is gated.</p>
              </div>
            )}

            {/* Model — free-form for local providers, dropdown for cloud */}
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Model</label>
              {isLocal ? (
                <>
                  <input
                    className="input"
                    list={`models-${provider.id}`}
                    value={form.model}
                    onChange={set('model')}
                    placeholder="e.g. llama3.2, deepseek-r1:7b, qwen2.5-coder:32b"
                    required
                  />
                  {(dynamicModels.length > 0 ? dynamicModels : provider.models).length > 0 && (
                    <datalist id={`models-${provider.id}`}>
                      {(dynamicModels.length > 0 ? dynamicModels : provider.models).map((m: string) => <option key={m} value={m} />)}
                    </datalist>
                  )}
                  <p className="form-hint">Enter the exact model name available on your server (e.g. from <code>ollama list</code>).</p>
                </>
              ) : (
                <>
                  <select className="input" value={form.model} onChange={set('model')}>
                    {(dynamicModels.length > 0 ? dynamicModels : provider.models).map((m: string) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <p className="form-hint">Choose the model for your agents. Start with smaller/faster options for testing to save cost.</p>
                </>
              )}
            </div>

            {testResult && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: testResult.success ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${testResult.success ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`, color: testResult.success ? '#10b981' : '#ef4444', fontSize: 13 }}>
                {testResult.success ? '✓' : '✗'} {testResult.message} {testResult.latency ? `(${testResult.latency}ms)` : ''}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={test} disabled={testing} style={{ flex: 1, justifyContent: 'center' }}>
                {testing ? '⟳ Testing...' : '🔌 Test Connection'}
              </button>
              <button className="btn btn-primary btn-sm" type="submit" disabled={saving} style={{ flex: 2, justifyContent: 'center' }}>
                {saving ? '⟳ Saving...' : '✓ Save'}
              </button>
              {isConfigured && (
                <button type="button" className="btn btn-danger btn-sm" onClick={remove} disabled={removing} data-tooltip="Remove this provider">
                  {removing ? '⟳' : '✕'}
                </button>
              )}
            </div>
          </div>
        </form>
      )}
      {ConfirmDialog}
    </div>
  )
}

export default function SettingsPage() {
  const { tenantId, toast } = useApp()
  const [settings, setSettings] = useState<any>(null)
  const [tab, setTab] = useState<'llm' | 'general' | 'members' | 'custom_models' | 'knowledge_infra' | 'system'>('llm')
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [loadingMembers, setLoadingMembers] = useState(true)
  const [members, setMembers] = useState<any[]>([])
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'BUILDER', password: '' })
  const [showInvitePassword, setShowInvitePassword] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [generalForm, setGeneralForm] = useState({ name: '' })
  const [savingGeneral, setSavingGeneral] = useState(false)
  const [isLocalEnv, setIsLocalEnv] = useState(false)
  const [savingSystemLlm, setSavingSystemLlm] = useState(false)

  // Custom Models state
  const { confirm, ConfirmDialog } = useConfirm()
  const [customModels, setCustomModels] = useState<any[]>([])
  const [modelForm, setModelForm] = useState({ modelName: '', baseModelPath: '', baseModelSource: 'ollama', localModelPath: '', lmStudioUrl: 'http://localhost:1234/v1', lmStudioModel: '', dataSource: 'file', datasetPath: '', dbConnectionString: '', dbQuery: '', webUrl: '' })
  const [training, setTraining] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<any[]>([])
  const [selectedLog, setSelectedLog] = useState<string | null>(null)
  const [activatingId, setActivatingId] = useState<string | null>(null)
  const [retrainingId, setRetrainingId] = useState<string | null>(null)
  const [streamingLogs, setStreamingLogs] = useState<Record<string, string[]>>({})
  const [activeStream, setActiveStream] = useState<string | null>(null)
  const [testingDb, setTestingDb] = useState(false)
  const [dbTestResult, setDbTestResult] = useState<any>(null)

  // System Scan state
  const [scanResults, setScanResults] = useState<any>(null)
  const [scanning, setScanning] = useState(false)
  const [installingId, setInstallingId] = useState<string | null>(null)

  // Knowledge Infrastructure state
  const [infraStatus, setInfraStatus] = useState<any>(null)
  const [infraLoading, setInfraLoading] = useState(false)
  const [infraStarting, setInfraStarting] = useState<string | null>(null)
  const [infraCreating, setInfraCreating] = useState<string | null>(null)

  async function runScan() {
    if (!tenantId) return
    setScanning(true); setScanResults(null)
    try {
      const scanData = await api.systemScan(tenantId)
      // api.systemScan already unwraps the envelope — scanData is { os, hostname, results }
      setScanResults(scanData)
    } catch (err: any) {
      toast('error', 'Scan failed', err.message)
    } finally { setScanning(false) }
  }

  async function installDep(depId: string, depName: string) {
    if (!tenantId) return
    setInstallingId(depId)
    try {
      const result = await api.systemInstall(tenantId, depId)
      if (result?.alreadyInstalled) {
        toast('info', `${depName} already installed`, '')
      } else if (result?.success) {
        toast('success', `${depName} installed`, result?.output || '')
      } else {
        toast('error', `Install failed`, result?.output || '')
      }
      // Re-scan after install attempt
      await runScan()
    } catch (err: any) {
      toast('error', `Install failed`, err.message)
    } finally { setInstallingId(null) }
  }

  async function loadInfraStatus() {
    if (!tenantId) return
    setInfraLoading(true)
    try {
      const data = await api.getKnowledgeInfraStatus(tenantId)
      setInfraStatus(data)
    } catch (err: any) {
      toast('error', 'Failed to check infrastructure status', err.message)
    } finally { setInfraLoading(false) }
  }

  async function startInfra(service: string, label: string) {
    if (!tenantId) return
    setInfraStarting(service)
    try {
      const result = await api.startKnowledgeService(tenantId, service)
      if (result.success) {
        toast('success', `${label} started`, result.output || 'Service is now running.')
      } else if (result.alreadyRunning) {
        toast('info', `${label} already running`, '')
      } else {
        toast('error', 'Failed to start', result.output || 'Unknown error')
      }
      await loadInfraStatus()
    } catch (err: any) {
      toast('error', `Failed to start ${label}`, err.message)
    } finally { setInfraStarting(null) }
  }

  async function createConnector(service: string, label: string) {
    if (!tenantId) return
    setInfraCreating(service)
    try {
      const result = await api.createInfraConnector(tenantId, service)
      toast('success', `${label} backend registered!`, result.alreadyExisted ? 'Backend was already registered and is ready to use.' : 'Your Knowledge Bases & Graphs can now use this backend.')
      await loadInfraStatus()
    } catch (err: any) {
      toast('error', 'Failed to register backend', err.message)
    } finally { setInfraCreating(null) }
  }

  async function testDbConnection() {
    if (!modelForm.dbConnectionString) {
      toast('error', 'Connection String Required', 'Please enter a valid PostgreSQL or MySQL connection string.')
      return
    }
    setTestingDb(true); setDbTestResult(null)
    try {
      const res = await api.testDbConnection(tenantId, { dbConnectionString: modelForm.dbConnectionString })
      setDbTestResult({ success: true, message: res.message, tables: res.tables })
      toast('success', 'Database Connected!', res.message)
    } catch (err: any) {
      setDbTestResult({ success: false, message: err.message })
      toast('error', 'Database Connection Failed', err.message)
    } finally { setTestingDb(false) }
  }

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsLocalEnv(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    }
  }, [])

  const load = useCallback(async (tid: string) => {
    // Load settings first (usually faster and needed for all tabs)
    api.getSettings(tid)
      .then(s => {
        setSettings(s)
        setGeneralForm({ name: s.name })
        setLoadingSettings(false)
      })
      .catch(err => {
        toast('error', 'Failed to load settings', err.message)
        setLoadingSettings(false)
      })
    
    // Load members separately (only needed for members tab)
    api.getMembers(tid)
      .then(m => {
        setMembers(m.members || [])
        setLoadingMembers(false)
      })
      .catch(err => {
        toast('error', 'Failed to load members', err.message)
        setLoadingMembers(false)
      })

    // Load custom models
    api.getCustomModels(tid)
      .then(res => {
        if (res.customModels) setCustomModels(res.customModels)
      })
      .catch(() => {})

    // Load locally available Ollama models for base model picker
    api.getOllamaAvailableModels(tid)
      .then(r => { const models = r?.data?.models || r?.models || []; if (models.length) setOllamaModels(models) })
      .catch(() => {})
  }, [toast])

  useEffect(() => {
    if (tenantId) load(tenantId)
  }, [tenantId, load])

  // Auto-load knowledge infra status when that tab is selected
  useEffect(() => {
    if (tenantId && tab === 'knowledge_infra') loadInfraStatus()
  }, [tenantId, tab])

  // Show message if sysadmin without tenant
  if (!tenantId) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Settings</h1>
        </div>
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Shield size={48} style={{ color: 'var(--green)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>System Administrator</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
            You're logged in as a system administrator without an organization.
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            Settings are organization-specific. Use the <strong>System Portal</strong> to manage all organizations.
          </p>
        </div>
      </div>
    )
  }

  const providers = settings?.llm_config?.providers || {}
  const defaultProvider = settings?.llm_config?.defaultProvider

  async function invite(e: any) {
    e.preventDefault(); setInviting(true)
    try {
      await api.inviteMember(tenantId, inviteForm)
      setInviteForm({ email: '', role: 'BUILDER', password: '' })
      await load(tenantId)
      const action = inviteForm.password ? 'created' : 'invited'
      toast('success', `Member ${action}`, `${inviteForm.email} has been ${action}.`)
    } catch (err: any) { toast('error', 'Invite failed', err.message) } finally { setInviting(false) }
  }

  async function saveGeneral(e: any) {
    e.preventDefault(); setSavingGeneral(true)
    try {
      await api.saveGeneralSettings(tenantId, generalForm)
      await load(tenantId)
      toast('success', 'Settings saved', 'Organisation settings updated.')
    } catch (err: any) { toast('error', 'Save failed', err.message) } finally { setSavingGeneral(false) }
  }

  async function setDefault(provider: string) {
    // Don't allow setting an unconfigured provider as default
    if (!providers[provider]) {
      toast('error', 'Provider not configured', `Configure "${PROVIDERS.find(p => p.id === provider)?.name || provider}" first before setting as default.`)
      return
    }
    try {
      const result = await api.saveLLMConfig(tenantId, { provider })
      if (result?.llm_config) {
        setSettings((s: any) => ({ ...s, llm_config: result.llm_config }))
      } else {
        await load(tenantId)
      }
      toast('success', 'Default provider updated', `${PROVIDERS.find(p => p.id === provider)?.name || provider} is now the default`)
    } catch (err: any) { toast('error', 'Update failed', err.message) }
  }

  async function saveSystemLlm(systemProvider: string | null, systemModel: string | null) {
    setSavingSystemLlm(true)
    try {
      const result = await api.saveSystemLLMConfig(tenantId, { systemProvider, systemModel })
      if (result?.llm_config) {
        setSettings((s: any) => ({ ...s, llm_config: result.llm_config }))
      } else {
        await load(tenantId)
      }
      toast('success', 'System AI updated', 'Platform AI features will use this provider.')
    } catch (err: any) { toast('error', 'Update failed', err.message) }
    finally { setSavingSystemLlm(false) }
  }

  const TABS = [
    { id: 'llm', label: 'LLM Providers' },
    { id: 'general', label: 'General' },
    { id: 'members', label: 'Members' }
  ]
  if (isLocalEnv) {
    TABS.push({ id: 'custom_models', label: 'Custom Models (Local)' })
    TABS.push({ id: 'knowledge_infra', label: 'Knowledge Backends' })
    TABS.push({ id: 'system', label: 'System Scan' })
  }

  async function startTraining(e: any) {
    e.preventDefault()
    setTraining(true)
    try {
      const payload: any = { modelName: modelForm.modelName, baseModelPath: modelForm.baseModelPath, dataSource: modelForm.dataSource }
      if (modelForm.dataSource === 'file') payload.datasetPath = modelForm.datasetPath
      if (modelForm.dataSource === 'database') { payload.dbConnectionString = modelForm.dbConnectionString; payload.dbQuery = modelForm.dbQuery }
      if (modelForm.dataSource === 'web') payload.webUrl = modelForm.webUrl

      const res = await api.trainCustomModel(tenantId, payload)
      const newModel = res.customModel
      setCustomModels(prev => {
        const idx = prev.findIndex(m => m.id === newModel.id)
        if (idx !== -1) {
          const next = [...prev]
          next[idx] = newModel
          return next
        }
        return [newModel, ...prev].slice(0, 20)
      })
      setModelForm({ modelName: '', baseModelPath: '', baseModelSource: 'ollama', localModelPath: '', lmStudioUrl: '', lmStudioModel: '', dataSource: 'file', datasetPath: '', dbConnectionString: '', dbQuery: '', webUrl: '' })
      toast('success', 'Training job started!', `"${newModel.model_name}" is now being trained. Live logs streaming below.`)
      openLogStream(newModel.id, true)

      // Poll every 3s until completed/failed
      const pollId = setInterval(async () => {
        try {
          const fresh = await api.getCustomModels(tenantId)
          if (fresh.customModels) {
            setCustomModels(fresh.customModels)
            const job = fresh.customModels.find((m: any) => m.id === newModel.id)
            if (job && (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'TRAINED')) {
              clearInterval(pollId)
              if (job.status === 'TRAINED') {
                toast('success', '✅ Training phase complete!', `"${job.model_name}" is ready for your approval.`)
              } else if (job.status === 'COMPLETED') {
                toast('success', '✅ Training & Push complete!', `"${job.model_name}" is now your active local model.`)
                await load(tenantId) // refresh LLM provider config too
              } else {
                toast('error', 'Training failed', job.error_message || 'Unknown error')
              }
            }
          }
        } catch {}
      }, 3000)
    } catch (err: any) {
      toast('error', 'Training failed', err.message)
    } finally {
      setTraining(false)
    }
  }

  async function activateModel(modelId: string, modelName: string) {
    setActivatingId(modelId)
    try {
      await api.activateCustomModel(tenantId, modelId)
      await load(tenantId)
      toast('success', `✅ "${modelName}" activated!`, 'All agents will now use this model via Ollama.')
    } catch (err: any) {
      toast('error', 'Activation failed', err.message)
    } finally {
      setActivatingId(null)
    }
  }

  async function deleteModel(e: any, modelId: string, modelName: string) {
    e.stopPropagation()
    const ok = await confirm({
      title: `Delete "${modelName}"?`,
      description: 'This will remove it from your jobs list. It will not delete the physical files from your local registry.',
      variant: 'danger',
      confirmLabel: 'Delete'
    })
    if (!ok) return
    try {
      await api.deleteCustomModel(tenantId, modelId)
      setCustomModels(prev => prev.filter(m => m.id !== modelId))
      if (selectedLog === modelId) { setSelectedLog(null); setActiveStream(null) }
      toast('success', `Model deleted`, `"${modelName}" was removed from your jobs.`)
    } catch (err: any) {
      toast('error', 'Delete failed', err.message)
    }
  }

  async function pushModelToOllama(modelId: string, modelName: string) {
    try {
      await api.pushToOllama(tenantId, modelId)
      setCustomModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'COMPLETED' } : m))
      toast('success', `Added to Ollama!`, `"${modelName}" is now available in your local registry.`)
    } catch (err: any) {
      toast('error', 'Failed to add to Ollama', err.message)
    }
  }

  function populateRetrainForm(m: any) {
    const isLMStudio = m.base_model_path.startsWith('lmstudio:')
    const isLocalFile = m.base_model_path.startsWith('/') || /^[A-Za-z]:\\/.test(m.base_model_path)
    const srcType = isLMStudio ? 'lmstudio' : isLocalFile ? 'localpath' : m.base_model_path.includes('/') ? 'huggingface' : 'ollama'

    setModelForm({
      modelName: m.model_name,
      baseModelPath: m.base_model_path,
      baseModelSource: srcType,
      localModelPath: isLocalFile ? m.base_model_path : '',
      lmStudioUrl: 'http://localhost:1234/v1',
      lmStudioModel: isLMStudio ? m.base_model_path.replace('lmstudio:', '') : '',
      dataSource: m.data_source,
      datasetPath: m.dataset_path || '',
      dbConnectionString: m.db_connection_string || '',
      dbQuery: m.db_query || '',
      webUrl: m.web_url || ''
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function openLogStream(modelId: string, isTraining: boolean) {
    if (selectedLog === modelId) { setSelectedLog(null); setActiveStream(null); return }
    setSelectedLog(modelId)
    if (!isTraining) return // static stored log shown in drawer
    setActiveStream(modelId)
    setStreamingLogs(prev => ({ ...prev, [modelId]: [] }))

    let es: EventSource | null = null
    let doneReceived = false
    let retryCount = 0
    const maxRetries = 10
    let cachedStreamToken: string | null = null // set from SSE 'connected' event

    async function connect() {
      if (doneReceived) return

      // Use cached stream_token (from SSE 'connected' event) or fetch it via api client
      let streamToken = cachedStreamToken
      if (!streamToken) {
        try {
          const res = await api.getCustomModel(tenantId, modelId)
          const token = res?.data?.customModel?.stream_token || res?.stream_token
          if (token) streamToken = token
        } catch { /* proceed without token if fetch fails */ }
      }

      // Build URL: prefer stream_token; without it, SSE cannot authenticate
      if (!streamToken) { setActiveStream(null); return }
      const url = `${API}/tenants/${tenantId}/custom-models/${modelId}/log-stream?stream_token=${encodeURIComponent(streamToken)}`
      es = new EventSource(url)

      // Capture stream_token from 'connected' event for future reconnections
      es.addEventListener('connected', (e: any) => {
        const data = JSON.parse(e.data)
        if (data.streamToken) cachedStreamToken = data.streamToken
      })
      
      es.addEventListener('log', (e: any) => {
        const { line } = JSON.parse(e.data)
        retryCount = 0 // reset retry on successful data
        setStreamingLogs(prev => ({ ...prev, [modelId]: [...(prev[modelId] || []), line] }))
      })
      
      es.addEventListener('done', (e: any) => {
        if (doneReceived) return
        doneReceived = true
        const { status } = JSON.parse(e.data)
        let msg = ''
        if (status === 'COMPLETED') msg = '✅ Setup complete!'
        else if (status === 'TRAINED') msg = '⏳ Training phase complete. Waiting for approval...'
        else msg = '❌ Job failed.'
        setStreamingLogs(prev => ({ ...prev, [modelId]: [...(prev[modelId] || []), msg] }))
        es?.close()
        setActiveStream(null)
        load(tenantId)
      })
      
      es.onerror = () => {
        if (doneReceived) { es?.close(); return }
        // Retry with exponential backoff — re-fetches stream_token or JWT each time
        es?.close()
        retryCount++
        if (retryCount > maxRetries) { setActiveStream(null); return }
        setTimeout(connect, Math.min(1000 * Math.pow(1.5, retryCount), 15000))
      }
    }

    connect()
  }

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Configure your organisation, AI providers, and team</p>
        </div>
      </div>

      <div className="tab-bar" style={{ marginTop: 20 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as any)}
            className={`tab-bar-item ${tab === t.id ? 'active' : ''}`}
          >{t.label}</button>
        ))}
      </div>

      <div className="page-body">

      {tab === 'llm' ? (
        loadingSettings ? (
          <div className="skeleton" style={{ height: 400, borderRadius: 12 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Default provider banner */}
            {defaultProvider && (
              <div style={{ padding: '14px 18px', borderRadius: 10, background: 'var(--green-bg)', border: '1px solid var(--green-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Default Provider: </span>
                  <span style={{ fontWeight: 700, color: 'var(--green-dark)' }}>{defaultProvider}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 12 }}>Used by all agents unless overridden per-agent</span>
                </div>
                {Object.keys(providers).length > 1 && (
                  <select
                    className="select"
                    style={{ minWidth: 140, fontSize: 13 }}
                    value={defaultProvider}
                    onChange={e => setDefault(e.target.value)}
                  >
                    {Object.keys(providers).map(pid => (
                      <option key={pid} value={pid}>{PROVIDERS.find(p => p.id === pid)?.name || pid}</option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* System AI selector — controls which LLM powers platform features */}
            {Object.keys(providers).length > 0 && (
              <div className="card" style={{ padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>🤖 System AI</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                      Powers platform features like workflow generation, agent creation, and AI assistants.
                      {!settings?.llm_config?.systemProvider && (
                        <span style={{ color: 'var(--yellow-dark)' }}> Currently using agent default.</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select
                      className="select"
                      style={{ minWidth: 130, fontSize: 13 }}
                      value={settings?.llm_config?.systemProvider || ''}
                      onChange={async e => {
                        const sp = e.target.value || null
                        const providers = settings?.llm_config?.providers || {}
                        await saveSystemLlm(sp, sp ? (providers[sp]?.model || null) : null)
                      }}
                      disabled={savingSystemLlm}
                    >
                      <option value="">Use Agent Default</option>
                      {Object.keys(providers).map(pid => (
                        <option key={pid} value={pid}>{PROVIDERS.find(p => p.id === pid)?.name || pid}</option>
                      ))}
                    </select>
                    {settings?.llm_config?.systemProvider && providers[settings.llm_config.systemProvider] && (
                      <select
                        className="select"
                        style={{ minWidth: 180, fontSize: 13 }}
                        value={settings?.llm_config?.systemModel || ''}
                        onChange={e => {
                          const sm = e.target.value || null
                          saveSystemLlm(settings?.llm_config?.systemProvider, sm)
                        }}
                        disabled={savingSystemLlm}
                      >
                        <option value="">Provider default model</option>
                        {(() => {
                          const sp = settings?.llm_config?.systemProvider
                          const pm = providers[sp]?.model
                          if (pm) return <option key={`cfg-${pm}`} value={pm}>{pm}</option>
                          return null
                        })()}
                        {(() => {
                          // Show models relevant to the selected system provider
                          const sp = settings?.llm_config?.systemProvider
                          if (sp === 'ollama') {
                            // Ollama: show locally available models (objects with .name)
                            return ollamaModels
                              .filter((m: any) => m?.name)
                              .map((m: any) => (
                                <option key={`ollama-${m.name}`} value={m.name}>{m.name}</option>
                              ))
                          }
                          // Cloud providers: show common models
                          const CLOUD_MODELS: Record<string, string[]> = {
                            openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o3-mini', 'o1'],
                            anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
                            openrouter: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-pro-1.5', 'meta-llama/llama-3.1-70b-instruct'],
                            opencode: ['deepseek-v4-pro', 'minimax-m3', 'qwen3.7-max', 'mimo-v2-pro'],
                            deepseek: ['deepseek-chat', 'deepseek-reasoner'],
                            kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-auto'],
                            groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
                            mistral: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
                          }
                          const models = CLOUD_MODELS[sp]
                          if (models) {
                            return models.map(m => {
                              const isDuplicate = m === providers[sp]?.model
                              if (isDuplicate) return null // already shown above
                              return <option key={`cloud-${m}`} value={m}>{m}</option>
                            })
                          }
                          return null
                        })()}
                        {/* Always show Ollama models at the bottom as fallback, deduped */}
                        {(() => {
                          const sp = settings?.llm_config?.systemProvider
                          if (sp !== 'ollama') {
                            return ollamaModels
                              .filter((m: any) => m?.name)
                              .map((m: any) => (
                                <option key={`extra-${m.name}`} value={m.name}>{m.name} (Ollama)</option>
                              ))
                          }
                          return null
                        })()}
                      </select>
                    )}
                    {savingSystemLlm && (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>⟳ Saving…</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Provider cards */}
            {PROVIDERS.filter(p => p.kind !== 'local' || isLocalEnv).map(p => (
              <ProviderCard
                key={p.id}
                provider={p}
                config={providers[p.id]}
                tenantId={tenantId}
                onSaved={(updatedConfig?: any) => {
                  if (updatedConfig) {
                    setSettings((s: any) => ({ ...s, llm_config: updatedConfig }))
                  } else {
                    load(tenantId)
                  }
                }}
                toast={toast}
              />
            ))}

            <div className="card" style={{ padding: 18, background: 'rgba(255,255,255,0.02)' }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                🔒 <strong>Security:</strong> API keys are stored encrypted in the database. They are never returned in full — only the first 8 characters are shown. Keys are only used server-side during agent task execution.
              </p>
            </div>
          </div>
        )
      ) : tab === 'general' ? (
        loadingSettings ? (
          <div className="skeleton" style={{ height: 400, borderRadius: 12 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div className="card" style={{ padding: 28 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>Organisation Details</h2>
              <form onSubmit={saveGeneral} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Organisation Name</label>
                  <input className="input" value={generalForm.name} onChange={e => setGeneralForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Workspace Slug</label>
                  <input className="input" value={settings?.slug} disabled style={{ opacity: 0.5 }} />
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Slug cannot be changed after creation</p>
                </div>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Plan</label>
                  <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 8 }}>
                    <span style={{ fontWeight: 600 }}>{settings?.plan || 'FREE'} Plan</span>
                  </div>
                </div>
                <button className="btn btn-primary btn-sm" type="submit" disabled={savingGeneral} style={{ alignSelf: 'flex-start' }}>
                  {savingGeneral ? '⟳ Saving...' : '✓ Save Changes'}
                </button>
              </form>
            </div>

            <div className="card" style={{ padding: 28, border: '1px solid rgba(239,68,68,0.2)' }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: '#ef4444' }}>Danger Zone</h2>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>Permanently delete this organisation and all its data. This cannot be undone.</p>
              <button className="btn btn-danger btn-sm" onClick={() => toast('info', 'Contact support', 'Please email support@kuvalam.ai to delete your organisation.')}>Delete Organisation</button>
            </div>
          </div>
        )
      ) : tab === 'members' ? (
        loadingMembers ? (
          <div className="skeleton" style={{ height: 400, borderRadius: 12 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Invite / Create form */}
            <div className="card" style={{ padding: 24 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
                {inviteForm.password ? 'Create Team Member' : 'Invite Team Member'}
              </h2>
              <form onSubmit={invite} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 10 }}>
                  <input className="input" type="email" placeholder="colleague@company.com" value={inviteForm.email} onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))} required style={{ flex: 2 }} />
                  <select className="input" value={inviteForm.role} onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))} style={{ flex: 1 }}>
                    {['ADMIN', 'BUILDER', 'VIEWER'].map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{ position: 'relative', flex: 1 }}>
                    <input
                      className="input"
                      type={showInvitePassword ? 'text' : 'password'}
                      placeholder="Set password (optional — leave blank to send invite)"
                      value={inviteForm.password}
                      onChange={e => setInviteForm(f => ({ ...f, password: e.target.value }))}
                      minLength={8}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-sm btn-secondary"
                    onClick={() => setShowInvitePassword(p => !p)}
                    style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    {showInvitePassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {inviteForm.password
                      ? '✓ Member will be created with direct password access'
                      : 'Member will receive an email invitation to join'}
                  </span>
                  <button className="btn btn-primary btn-sm" type="submit" disabled={inviting} style={{ flexShrink: 0 }}>
                    {inviting ? '⟳' : inviteForm.password ? 'Create Member' : '+ Invite'}
                  </button>
                </div>
              </form>
            </div>

            {/* Members list */}
            <div className="card" style={{ padding: 24 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Team ({members.length})</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {members.map(m => (
                  <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg, var(--green) 0%, var(--yellow-light) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: 'white' }}>
                        {m.name?.[0]?.toUpperCase() || 'U'}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.email}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, padding: '3px 10px', background: 'var(--green-bg)', color: 'var(--green-dark)', borderRadius: 20, border: '1px solid var(--green-border)', fontWeight: 600 }}>{m.role}</span>
                      <span className={`badge badge-${m.status.toLowerCase()}`} style={{ fontSize: 10 }}>{m.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      ) : tab === 'custom_models' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="card" style={{ padding: 28, background: 'linear-gradient(to right, rgba(16, 185, 129, 0.05), transparent)' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>🚀</span> Train Custom Model (Local GPU)
            </h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
              Fine-tune an open-source LLM on your organization&apos;s data. Kuvalam will orchestrate a LoRA training job and auto-import the result into your local execution engine (Ollama).
            </p>
            
            <form onSubmit={startTraining} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Target Model Name</label>
                  <input className="input" placeholder="e.g. acme-legal-v1" value={modelForm.modelName} onChange={e => setModelForm(f => ({ ...f, modelName: e.target.value }))} required list="existing-models" />
                  <datalist id="existing-models">
                    {customModels.map(m => <option key={m.id} value={m.model_name} />)}
                  </datalist>
                  <p className="form-hint" style={{ marginTop: 4, color: customModels.some(m => m.model_name === modelForm.modelName) ? '#8b5cf6' : 'var(--text-muted)' }}>
                    {customModels.some(m => m.model_name === modelForm.modelName) ? '🔄 Existing model selected. Submitting will bump version and retrain.' : 'Exact name to register in Ollama after training.'}
                  </p>
                </div>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Base Model Source</label>
                  {/* Source type toggle */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                    {[
                      { id: 'ollama', label: '🦙 Ollama', hint: 'Local Ollama model' },
                      { id: 'localpath', label: '📁 Local Path', hint: 'GGUF / safetensors file' },
                      { id: 'lmstudio', label: '🖥️ LM Studio', hint: 'Running LM Studio server' },
                      { id: 'huggingface', label: '☁️ HuggingFace', hint: 'Download & fine-tune' },
                    ].map(src => (
                      <button
                        key={src.id}
                        type="button"
                        onClick={() => setModelForm(f => ({ ...f, baseModelSource: src.id, baseModelPath: src.id === 'huggingface' ? 'unsloth/Llama-3.2-1B-Instruct' : '' }))}
                        style={{
                          padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid',
                          borderColor: modelForm.baseModelSource === src.id ? 'var(--green)' : 'var(--border)',
                          background: modelForm.baseModelSource === src.id ? 'rgba(16,185,129,0.12)' : 'transparent',
                          color: modelForm.baseModelSource === src.id ? 'var(--green-dark)' : 'var(--text-muted)'
                        }}
                        title={src.hint}
                      >{src.label}</button>
                    ))}
                  </div>

                  {/* Ollama local models */}
                  {modelForm.baseModelSource === 'ollama' && (
                    <>
                      <select className="input" value={modelForm.baseModelPath} onChange={e => setModelForm(f => ({ ...f, baseModelPath: e.target.value }))} required>
                        <option value="" disabled>Select a local Ollama model...</option>
                        {ollamaModels.map(m => (
                          <option key={m.name} value={m.name}>{m.name} — {(m.size / 1e9).toFixed(1)} GB</option>
                        ))}
                      </select>
                      {ollamaModels.length === 0 && <p className="form-hint" style={{ marginTop: 4, color: '#f59e0b' }}>⚠️ No Ollama models found. Run: <code>ollama pull llama3.2</code></p>}
                      {ollamaModels.length > 0 && <p className="form-hint" style={{ marginTop: 4 }}>✅ {ollamaModels.length} model(s) available locally.</p>}
                    </>
                  )}

                  {/* Local file path (GGUF / safetensors) */}
                  {modelForm.baseModelSource === 'localpath' && (
                    <>
                      <input
                        className="input"
                        placeholder="/Users/you/models/llama-3.2.Q4_K_M.gguf"
                        value={modelForm.localModelPath}
                        onChange={e => setModelForm(f => ({ ...f, localModelPath: e.target.value, baseModelPath: e.target.value }))}
                        required
                      />
                      <p className="form-hint" style={{ marginTop: 4 }}>Absolute path to a <code>.gguf</code> or <code>.safetensors</code> model file on this machine. Ollama will import it directly.</p>
                    </>
                  )}

                  {/* LM Studio */}
                  {modelForm.baseModelSource === 'lmstudio' && (
                    <>
                      <input
                        className="input"
                        placeholder="http://localhost:1234/v1"
                        value={modelForm.lmStudioUrl}
                        onChange={e => setModelForm(f => ({ ...f, lmStudioUrl: e.target.value }))}
                        style={{ marginBottom: 8 }}
                        required
                      />
                      <input
                        className="input"
                        placeholder="Model name loaded in LM Studio (e.g. llama-3.2-1b)"
                        value={modelForm.lmStudioModel}
                        onChange={e => setModelForm(f => ({ ...f, lmStudioModel: e.target.value, baseModelPath: `lmstudio:${e.target.value}` }))}
                        required
                      />
                      <p className="form-hint" style={{ marginTop: 4 }}>Ensure LM Studio&apos;s local server is running with the model loaded before starting.</p>
                    </>
                  )}

                  {/* HuggingFace download */}
                  {modelForm.baseModelSource === 'huggingface' && (
                    <>
                      <select className="input" value={modelForm.baseModelPath} onChange={e => setModelForm(f => ({ ...f, baseModelPath: e.target.value }))} required>
                        <option value="" disabled>Select a foundation model...</option>
                        <optgroup label="Llama (Meta)">
                          <option value="unsloth/Llama-3.2-1B-Instruct">Llama 3.2 (1B Instruct) — Fast, lightweight</option>
                          <option value="unsloth/Llama-3.2-3B-Instruct">Llama 3.2 (3B Instruct) — Balanced</option>
                          <option value="unsloth/Meta-Llama-3.1-8B-Instruct">Llama 3.1 (8B Instruct) — High performance</option>
                        </optgroup>
                        <optgroup label="Qwen (Alibaba)">
                          <option value="unsloth/Qwen2.5-7B-Instruct">Qwen 2.5 (7B) — Coding &amp; math</option>
                          <option value="unsloth/Qwen2.5-1.5B-Instruct">Qwen 2.5 (1.5B) — Fast inference</option>
                        </optgroup>
                        <optgroup label="Image / Multimodal & Vision (Black Forest Labs)">
                          <option value="black-forest-labs/FLUX.1-schnell">FLUX.1 Schnell (12B) — Black Forest Labs (Fast text-to-image)</option>
                        </optgroup>
                        <optgroup label="Other">
                          <option value="unsloth/Mistral-7B-Instruct-v0.3">Mistral (7B v0.3) — Reasoning</option>
                          <option value="unsloth/gemma-2-9b-it">Gemma 2 (9B IT) — Google</option>
                        </optgroup>
                      </select>
                      <p className="form-hint" style={{ marginTop: 4 }}>⚠️ Requires GPU + Unsloth installed. Will download from HuggingFace Hub on first run.</p>
                    </>
                  )}
                </div>
              </div>

              <div style={{ padding: 16, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8 }}>
                <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 12, fontWeight: 600 }}>Training Data Source</label>
                <select className="input" value={modelForm.dataSource} onChange={e => setModelForm(f => ({ ...f, dataSource: e.target.value }))} style={{ marginBottom: 16 }}>
                  <option value="file">Local Document (PDF, TXT, CSV, JSON)</option>
                  <option value="database">Database Query (PostgreSQL / MySQL)</option>
                  <option value="web">Internet URL / Web Crawl</option>
                </select>

                {modelForm.dataSource === 'file' && (
                  <div>
                    <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Document Path</label>
                    <input className="input" placeholder="e.g. /Users/admin/company_handbook.pdf" value={modelForm.datasetPath} onChange={e => setModelForm(f => ({ ...f, datasetPath: e.target.value }))} required />
                    <p className="form-hint" style={{ marginTop: 4 }}>We will automatically extract text from PDFs, Word Docs, or raw text files.</p>
                  </div>
                )}

                {modelForm.dataSource === 'database' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                      <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Connection String</label>
                      <input className="input" type="password" placeholder="postgresql://user:pass@host:port/db" value={modelForm.dbConnectionString} onChange={e => setModelForm(f => ({ ...f, dbConnectionString: e.target.value }))} required />
                    </div>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={testDbConnection} disabled={testingDb} style={{ alignSelf: 'flex-start' }}>
                      {testingDb ? '⟳ Testing Connection...' : '🔌 Test DB Connection'}
                    </button>
                    {dbTestResult && (
                      <div style={{ padding: '10px 14px', borderRadius: 8, background: dbTestResult.success ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${dbTestResult.success ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`, color: dbTestResult.success ? '#10b981' : '#ef4444', fontSize: 13 }}>
                        {dbTestResult.success ? '✓' : '✗'} {dbTestResult.message}
                      </div>
                    )}
                    <div>
                      <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>SQL Query (Optional)</label>
                      <textarea className="input" placeholder="Leave empty to automatically train on all tables, OR specify a query like: SELECT instruction, response FROM my_dataset" value={modelForm.dbQuery} onChange={e => setModelForm(f => ({ ...f, dbQuery: e.target.value }))} rows={3} style={{ resize: 'vertical' }} />
                    </div>
                  </div>
                )}

                {modelForm.dataSource === 'web' && (
                  <div>
                    <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Website URL</label>
                    <input className="input" placeholder="https://example.com/docs" value={modelForm.webUrl} onChange={e => setModelForm(f => ({ ...f, webUrl: e.target.value }))} required />
                    <p className="form-hint" style={{ marginTop: 4 }}>The crawler will extract the text content and convert it into conversational training pairs.</p>
                  </div>
                )}
              </div>

              <button className="btn btn-primary btn-sm" type="submit" disabled={training} style={{ alignSelf: 'flex-start', marginTop: 8 }}>
                {training ? '⟳ Processing...' : customModels.some(m => m.model_name === modelForm.modelName) ? '🔄 Retrain Existing Model' : '▶ Start Fine-Tuning Job'}
              </button>
            </form>
          </div>

          {/* ── Training Jobs ──────────────────────────────────────────────────── */}
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Training Jobs <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>(last 20)</span></h2>
            {customModels.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No custom models trained yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {customModels.map(m => (
                  <div key={m.id} style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: m.status === 'TRAINING' ? 'rgba(16,185,129,0.03)' : 'var(--bg-card)', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
                    {/* Job header row */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px' }}>
                      <div style={{ flex: 1, overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <h3 style={{ margin: 0, fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>{m.model_name}</h3>
                          {m.ollama_tag && m.ollama_tag !== m.model_name && (
                            <code style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 4, color: 'var(--text-muted)' }}>{m.ollama_tag}</code>
                          )}
                          {m.version > 1 && (
                            <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 20, background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)', fontWeight: 600 }}>v{m.version}</span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {m.data_source === 'file' ? '📄 Local File' : m.data_source === 'database' ? '🗄️ SQL Database' : '🌐 Web URL'}
                          </span>
                          <span style={{ color: 'var(--border)' }}>|</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, opacity: 0.8 }}>
                            Base: {m.base_model_path.split('/').pop() || m.base_model_path}
                          </span>
                          {m.status !== 'COMPLETED' && m.status !== 'TRAINED' && m.status !== 'TRAINING' && (
                            <>
                              <span style={{ color: 'var(--border)' }}>|</span>
                              <span className={`badge badge-${m.status.toLowerCase()}`} style={{ padding: '2px 6px' }}>{m.status}</span>
                            </>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, fontFamily: 'monospace', opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '85%' }}>
                          {m.data_source === 'file' ? m.dataset_path : m.data_source === 'database' ? (m.db_query || 'All Tables Context') : m.web_url}
                        </div>
                        {m.error_message && (
                          <div style={{ fontSize: 11, color: '#ef4444', marginTop: 8, background: 'rgba(239,68,68,0.1)', padding: '6px 10px', borderRadius: 6, display: 'inline-block' }}>
                            ⚠️ {m.error_message}
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 16 }}>
                        {/* Primary Action */}
                        {m.status === 'TRAINED' && (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => pushModelToOllama(m.id, m.model_name)}
                            style={{ fontSize: 12, background: '#10b981', color: '#fff', borderColor: '#059669', boxShadow: '0 2px 4px rgba(16,185,129,0.2)' }}
                          >
                            ✓ Push to Ollama
                          </button>
                        )}
                        {m.status === 'COMPLETED' && (
                          <>
                            {ollamaModels.some(om => om.name === m.ollama_tag || om.name === `${m.ollama_tag}:latest`) ? (
                              <span style={{ fontSize: 11, color: '#10b981', background: 'rgba(16,185,129,0.1)', padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(16,185,129,0.2)' }}>
                                🟢 Available
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' }} title="This model is not in your local Ollama registry. It may have been deleted manually.">
                                ⚠️ Missing
                              </span>
                            )}
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => activateModel(m.id, m.ollama_tag || m.model_name)}
                              disabled={activatingId === m.id || !ollamaModels.some(om => om.name === m.ollama_tag || om.name === `${m.ollama_tag}:latest`)}
                              style={{ fontSize: 12 }}
                            >
                              {activatingId === m.id ? '⟳ Activating...' : '⚡ Set Default'}
                            </button>
                          </>
                        )}
                        {m.status === 'TRAINING' && (
                          <>
                            <button
                              className="btn btn-sm"
                              onClick={() => openLogStream(m.id, true)}
                              style={{ fontSize: 12, background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.2)', display: 'flex', alignItems: 'center', gap: 6 }}
                            >
                              <span style={{ display: 'inline-block', width: 6, height: 6, background: '#10b981', borderRadius: '50%' }}></span>
                              {selectedLog === m.id ? 'Close Stream' : 'Live Stream'}
                            </button>
                            <button
                              className="btn btn-sm"
                              onClick={async () => {
                                try {
                                  await api.cancelTraining(tenantId, m.id)
                                  toast('info', 'Training cancelled', 'The job was stopped.')
                                  load(tenantId)
                                } catch (err: any) {
                                  toast('error', 'Failed to cancel', err.message)
                                }
                              }}
                              style={{ fontSize: 12, color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)' }}
                            >
                              ■ Cancel
                            </button>
                          </>
                        )}

                        <div style={{ width: 1, height: 24, background: 'var(--border)', margin: '0 4px' }} />

                        {/* Secondary Actions */}
                        {(m.train_log || m.status === 'COMPLETED' || m.status === 'FAILED') && m.status !== 'TRAINING' && (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => openLogStream(m.id, false)}
                            style={{ fontSize: 11, padding: '6px 10px' }}
                            title="View Logs"
                          >
                            📋 {selectedLog === m.id ? 'Close' : 'Logs'}
                          </button>
                        )}
                        {(m.status === 'COMPLETED' || m.status === 'FAILED' || m.status === 'TRAINED') && (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => populateRetrainForm(m)}
                            style={{ fontSize: 11, padding: '6px 10px' }}
                            title="Edit Config & Retrain"
                          >
                            ✏️ Edit
                          </button>
                        )}
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={(e) => deleteModel(e, m.id, m.model_name)}
                          style={{ fontSize: 11, padding: '6px 10px', color: '#ef4444', borderColor: 'transparent', background: 'transparent' }}
                          title="Delete Job"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                    {/* Log drawer — SSE stream for TRAINING, stored log for others */}
                    {selectedLog === m.id && (
                      <div style={{
                        padding: '12px 16px',
                        background: 'rgba(0,0,0,0.35)',
                        borderTop: '1px solid var(--border)',
                        maxHeight: 260,
                        overflowY: 'auto',
                        fontFamily: 'monospace',
                        fontSize: 11,
                        lineHeight: 1.8,
                        color: '#a3e8c4',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word'
                      }}>
                        {/* Header bar */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, opacity: 0.6, fontSize: 10 }}>
                          <span>{m.status === 'TRAINING' ? '📡 Live stream' : '📋 Training log'} — {m.model_name}</span>
                          <span>{new Date(m.updated_at).toLocaleTimeString()}</span>
                        </div>
                        {/* SSE lines for active stream */}
                        {activeStream === m.id && (streamingLogs[m.id] || []).map((line, i) => (
                          <div key={i} style={{ opacity: 0.9 }}>{line}</div>
                        ))}
                        {/* Stored log for completed jobs */}
                        {activeStream !== m.id && m.train_log}
                        {/* Blinking cursor while streaming */}
                        {activeStream === m.id && (
                          <span style={{ animation: 'pulse 1s ease-in-out infinite', color: '#10b981' }}>▋</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : tab === 'knowledge_infra' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Header card */}
          <div className="card" style={{ padding: 28, background: 'linear-gradient(to right, rgba(16, 185, 129, 0.08), rgba(99, 102, 241, 0.04))' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>🧬🕸️</span> Knowledge Backends
            </h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
              These are the underlying database services that power your Knowledge Bases (vector search) and Knowledge Graphs (entity traversal). Start them here, then manage your actual collections and graphs on the <strong>Knowledge</strong> page.
            </p>
            <div style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              💡 <strong>Tip:</strong> Go to <a href="/dashboard/knowledge" style={{ color: 'var(--green)', fontWeight: 600 }}>Knowledge →</a> to create and manage your Knowledge Bases & Graphs. This page only handles the backend database services that store the data.
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={loadInfraStatus}
              disabled={infraLoading}
              style={{ fontSize: 13 }}
            >
              {infraLoading ? '⟳ Checking...' : '🔄 Refresh Status'}
            </button>
          </div>

          {/* ── pgvector (Vector DB) card ──────────────────────────────────── */}
          <div className="card" style={{ padding: 24, border: infraStatus?.pgvector?.running ? '1px solid rgba(16,185,129,0.3)' : '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ flex: 1, minWidth: 250 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 32 }}>🧬</div>
                  <div>
                    <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Vector Database (pgvector)</h3>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                      PostgreSQL + pgvector extension — powers semantic search & RAG for your agents.
                    </p>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 13 }}>
                  {infraStatus ? (
                    <>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: infraStatus.pgvector?.running ? '#10b981' : '#ef4444', display: 'inline-block' }}></span>
                        <strong>{infraStatus.pgvector?.running ? 'Running' : 'Stopped'}</strong>
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {infraStatus.pgvector?.host}:{infraStatus.pgvector?.port}
                      </span>
                      {infraStatus.pgvector?.connectorId && (
                        <span style={{ color: '#10b981', background: 'rgba(16,185,129,0.1)', padding: '2px 8px', borderRadius: 20, fontSize: 11, border: '1px solid rgba(16,185,129,0.2)' }}>
                          ✓ Backend ready (auto-connected)
                        </span>
                      )}
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>Click <strong>Refresh Status</strong> to check</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                {infraStatus && !infraStatus.pgvector?.running && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => startInfra('pgvector', 'pgvector')}
                    disabled={infraStarting === 'pgvector'}
                    style={{ fontSize: 12 }}
                  >
                    {infraStarting === 'pgvector' ? '⟳ Starting...' : '▶ Start pgvector'}
                  </button>
                )}
                {infraStatus && infraStatus.pgvector?.running && !infraStatus.pgvector?.connectorId && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => createConnector('pgvector', 'pgvector')}
                    disabled={infraCreating === 'pgvector'}
                    style={{ fontSize: 12, background: '#10b981', borderColor: '#059669' }}
                  >
                    {infraCreating === 'pgvector' ? '⟳ Creating...' : '🔌 Create Connector'}
                  </button>
                )}
                {infraStatus?.pgvector?.connectorId && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => window.location.href = '/dashboard/connectors'}
                    style={{ fontSize: 12 }}
                  >
                    View in Integrations →
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── Neo4j (Graph DB) card ──────────────────────────────────────── */}
          <div className="card" style={{ padding: 24, border: infraStatus?.neo4j?.running ? '1px solid rgba(99,102,241,0.3)' : '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ flex: 1, minWidth: 250 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 32 }}>🕸️</div>
                  <div>
                    <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Knowledge Graph (Neo4j)</h3>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                      Graph database for entity-relationship traversal. Agents can navigate structured knowledge.
                    </p>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 13 }}>
                  {infraStatus ? (
                    <>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: infraStatus.neo4j?.running ? '#10b981' : '#ef4444', display: 'inline-block' }}></span>
                        <strong>{infraStatus.neo4j?.running ? 'Running' : 'Stopped'}</strong>
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {infraStatus.neo4j?.host}:{infraStatus.neo4j?.boltPort}
                      </span>
                      {infraStatus.neo4j?.connectorId && (
                        <span style={{ color: '#8b5cf6', background: 'rgba(139,92,246,0.1)', padding: '2px 8px', borderRadius: 20, fontSize: 11, border: '1px solid rgba(139,92,246,0.2)' }}>
                          ✓ Backend ready (auto-connected)
                        </span>
                      )}
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>Click <strong>Refresh Status</strong> to check</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                {infraStatus && !infraStatus.neo4j?.running && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => startInfra('neo4j', 'Neo4j')}
                    disabled={infraStarting === 'neo4j'}
                    style={{ fontSize: 12 }}
                  >
                    {infraStarting === 'neo4j' ? '⟳ Starting...' : '▶ Start Neo4j'}
                  </button>
                )}
                {infraStatus && infraStatus.neo4j?.running && !infraStatus.neo4j?.connectorId && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => createConnector('neo4j', 'Neo4j')}
                    disabled={infraCreating === 'neo4j'}
                    style={{ fontSize: 12, background: '#8b5cf6', borderColor: '#7c3aed' }}
                  >
                    {infraCreating === 'neo4j' ? '⟳ Creating...' : '🔌 Create Connector'}
                  </button>
                )}
                {infraStatus?.neo4j?.connectorId && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => window.location.href = '/dashboard/connectors'}
                    style={{ fontSize: 12 }}
                  >
                    View in Integrations →
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── Docker not available warning ───────────────────────────────── */}
          {infraStatus && !infraStatus.docker?.available && (
            <div className="card" style={{ padding: 18, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <p style={{ fontSize: 13, color: '#f59e0b', margin: 0 }}>
                ⚠️ <strong>Docker is not available.</strong> Knowledge infrastructure requires Docker to run local services. Install Docker Desktop or run <code>brew install --cask docker</code> on macOS.
              </p>
            </div>
          )}

          {/* ── Info footer ────────────────────────────────────────────────── */}
          <div className="card" style={{ padding: 18, background: 'rgba(255,255,255,0.02)' }}>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              💡 <strong>How it works:</strong> These are the database services that run locally in Docker. Once started, they auto-register so your Knowledge Bases (vector search) and Knowledge Graphs (entity traversal) can store data. Go to <a href="/dashboard/knowledge" style={{ color: 'var(--green)', fontWeight: 600 }}>Knowledge →</a> to create collections and graphs on top of these backends.
            </p>
          </div>
        </div>
      ) : tab === 'system' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Header card */}
          <div className="card" style={{ padding: 28, background: 'linear-gradient(to right, rgba(99, 102, 241, 0.08), transparent)' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>🔍</span> System Dependency Scan
            </h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
              Scan your system for required and optional software dependencies. Missing packages can be installed automatically on macOS and Linux.
            </p>
            <button
              className="btn btn-primary btn-sm"
              onClick={runScan}
              disabled={scanning}
              style={{ fontSize: 13 }}
            >
              {scanning ? '⟳ Scanning...' : '🔍 Run System Scan'}
            </button>
          </div>

          {/* Results */}
          {scanResults && (
            <>
              {/* Summary banner */}
              <div className="card" style={{ padding: 16, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      <strong>{scanResults.os}</strong> · {scanResults.hostname}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
                    <span style={{ color: '#10b981' }}>
                      ✓ {scanResults.results.filter((r: any) => r.installed).length} installed
                    </span>
                    <span style={{ color: '#ef4444' }}>
                      ✗ {scanResults.results.filter((r: any) => !r.installed).length} missing
                    </span>
                  </div>
                </div>
              </div>

              {/* Category sections */}
              {['runtime', 'devtools', 'infra', 'ml', 'services'].map(cat => {
                const items = scanResults.results.filter((r: any) => r.category === cat)
                if (items.length === 0) return null
                const catLabel = cat === 'runtime' ? 'Runtime (Required)' : cat === 'devtools' ? 'Developer Tools' : cat === 'infra' ? 'Infrastructure' : cat === 'ml' ? 'ML / AI' : 'Runtime Services'
                const catIcon = cat === 'runtime' ? '⚙️' : cat === 'devtools' ? '🛠️' : cat === 'infra' ? '🏗️' : cat === 'ml' ? '🧠' : '📡'
                return (
                  <div key={cat} className="card" style={{ padding: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>{catIcon}</span> {catLabel}
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {items.map((r: any) => (
                        <div
                          key={r.id}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '12px 16px', borderRadius: 8,
                            background: r.installed ? 'rgba(16,185,129,0.04)' : r.required ? 'rgba(239,68,68,0.06)' : 'rgba(245,158,11,0.04)',
                            border: r.installed ? '1px solid rgba(16,185,129,0.12)' : r.required ? '1px solid rgba(239,68,68,0.18)' : '1px solid rgba(245,158,11,0.12)',
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{
                                fontSize: 14,
                                color: r.installed ? '#10b981' : r.required ? '#ef4444' : '#f59e0b'
                              }}>
                                {r.installed ? '✓' : '✗'}
                              </span>
                              <div>
                                <div style={{ fontWeight: 600, fontSize: 14 }}>
                                  {r.name}
                                  {r.required && (
                                    <span style={{ fontSize: 10, marginLeft: 8, padding: '1px 6px', borderRadius: 20, background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontWeight: 600 }}>
                                      REQUIRED
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                  {r.installed && r.version ? (
                                    <code style={{ fontSize: 11, color: '#10b981' }}>v{r.version}</code>
                                  ) : null}
                                  <span style={{ marginLeft: r.installed && r.version ? 8 : 0 }}>{r.description}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div style={{ flexShrink: 0, marginLeft: 16, display: 'flex', gap: 8 }}>
                            {!r.installed && r.installUrl && (
                              <a
                                href={r.installUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn btn-secondary btn-sm"
                                style={{ fontSize: 11, textDecoration: 'none' }}
                              >
                                📥 Download
                              </a>
                            )}
                            {!r.installed && r.installHint && cat !== 'services' && (
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => installDep(r.id, r.name)}
                                disabled={installingId === r.id}
                                style={{ fontSize: 11 }}
                              >
                                {installingId === r.id ? '⟳ Installing...' : '🔧 Install'}
                              </button>
                            )}
                            {!r.installed && r.installHint && cat === 'services' && (
                              <code style={{ fontSize: 10, color: 'var(--text-muted)', padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)' }}>
                                {r.installHint}
                              </code>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}

              {/* Install hint footer */}
              <div className="card" style={{ padding: 18, background: 'rgba(255,255,255,0.02)' }}>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  💡 <strong>Tip:</strong> Install <a href="https://brew.sh" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--green)' }}>Homebrew</a> first — it simplifies installing all other dependencies on macOS and Linux with a single <code>brew install</code> command.
                </p>
              </div>
            </>
          )}
        </div>
      ) : null}


      </div>
      {ConfirmDialog}
    </div>
  )
}
