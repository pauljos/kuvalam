'use client'
import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'
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
  { id: 'groq', name: 'Groq (Fast)', icon: '⚡', color: '#f59e0b', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'], keyLabel: 'API Key', keyPlaceholder: 'gsk_...', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', name: 'Mistral AI', icon: '🌊', color: '#3b82f6', models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'], keyLabel: 'API Key', keyPlaceholder: 'your-mistral-key', baseUrl: 'https://api.mistral.ai/v1' },
  // ── Local / self-hosted OpenAI-compatible servers ──────────────────────────
  { id: 'ollama', name: 'Ollama (Local)', icon: '🦙', color: '#3f8a43', kind: 'local', models: ['llama3.2', 'llama3.1', 'mistral', 'gemma2', 'phi3', 'qwen2.5', 'deepseek-r1'], keyLabel: 'Base URL', keyPlaceholder: 'http://localhost:11434/v1', baseUrl: 'http://localhost:11434/v1', description: 'Run open models on your own machine with Ollama. No API key required.' },
  { id: 'lmstudio', name: 'LM Studio (Local)', icon: '🖥️', color: '#3f8a43', kind: 'local', models: ['local-model'], keyLabel: 'Base URL', keyPlaceholder: 'http://localhost:1234/v1', baseUrl: 'http://localhost:1234/v1', description: 'Uses LM Studio\u2019s built-in OpenAI-compatible server (enable it in the Server tab).' },
  { id: 'localai', name: 'LocalAI (Local)', icon: '🏠', color: '#3f8a43', kind: 'local', models: ['gpt-3.5-turbo', 'ggml-gpt4all-j'], keyLabel: 'Base URL', keyPlaceholder: 'http://localhost:8080/v1', baseUrl: 'http://localhost:8080/v1', description: 'Self-hosted, OpenAI-compatible inference server.' },
  { id: 'custom', name: 'Custom OpenAI-Compatible', icon: '🛠️', color: '#3f8a43', kind: 'local', models: [], keyLabel: 'Base URL', keyPlaceholder: 'https://your-server/v1', baseUrl: '', description: 'Point at any OpenAI-compatible endpoint (vLLM, llama.cpp, TGI, Together, Fireworks, etc.).' },
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
      await api.saveLLMConfig(tenantId, body)
      onSaved(); setOpen(false); setForm(f => ({ ...f, apiKey: '' }))
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
    try { await api.removeLLMProvider(tenantId, provider.id); onSaved(); toast('info', `${provider.name} removed`, '') }
    catch (err: any) { toast('error', 'Remove failed', err.message) } finally { setRemoving(false) }
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
                  {provider.models.length > 0 && (
                    <datalist id={`models-${provider.id}`}>
                      {provider.models.map((m: string) => <option key={m} value={m} />)}
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
  const [tab, setTab] = useState<'llm' | 'general' | 'members'>('llm')
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [loadingMembers, setLoadingMembers] = useState(true)
  const [members, setMembers] = useState<any[]>([])
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'BUILDER' })
  const [inviting, setInviting] = useState(false)
  const [generalForm, setGeneralForm] = useState({ name: '' })
  const [savingGeneral, setSavingGeneral] = useState(false)
  const [isLocalEnv, setIsLocalEnv] = useState(false)

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
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/tenants/${tid}/custom-models/ollama/available`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('kuvalam_access_token')}` }
    })
      .then(r => r.json())
      .then(r => { if (r.data?.models) setOllamaModels(r.data.models) })
      .catch(() => {})
  }, [toast])

  useEffect(() => {
    if (tenantId) load(tenantId)
  }, [tenantId, load])

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
      setInviteForm({ email: '', role: 'BUILDER' })
      await load(tenantId)
      toast('success', 'Invitation sent', `${inviteForm.email} has been invited.`)
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
    try { await api.saveLLMConfig(tenantId, { provider, model: providers[provider]?.model }); await load(tenantId); toast('success', 'Default provider updated', '') }
    catch (err: any) { toast('error', 'Update failed', err.message) }
  }

  const TABS = [
    { id: 'llm', label: 'LLM Providers' },
    { id: 'general', label: 'General' },
    { id: 'members', label: 'Members' }
  ]
  if (isLocalEnv) {
    TABS.push({ id: 'custom_models', label: 'Custom Models (Local)' })
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
      const token = localStorage.getItem('kuvalam_access_token')
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/tenants/${tenantId}/custom-models/${modelId}/activate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error?.message || 'Activation failed')
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
      const token = localStorage.getItem('kuvalam_access_token')
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/tenants/${tenantId}/custom-models/${modelId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error?.message || 'Delete failed')
      setCustomModels(prev => prev.filter(m => m.id !== modelId))
      if (selectedLog === modelId) { setSelectedLog(null); setActiveStream(null) }
      toast('success', `Model deleted`, `"${modelName}" was removed from your jobs.`)
    } catch (err: any) {
      toast('error', 'Delete failed', err.message)
    }
  }

  async function pushModelToOllama(modelId: string, modelName: string) {
    try {
      const token = localStorage.getItem('kuvalam_access_token')
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/tenants/${tenantId}/custom-models/${modelId}/push-to-ollama`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error?.message || 'Push failed')
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
    const token = localStorage.getItem('kuvalam_access_token')
    const es = new EventSource(`${process.env.NEXT_PUBLIC_API_URL}/tenants/${tenantId}/custom-models/${modelId}/log-stream?token=${token}`)
    es.addEventListener('log', (e: any) => {
      const { line } = JSON.parse(e.data)
      setStreamingLogs(prev => ({ ...prev, [modelId]: [...(prev[modelId] || []), line] }))
    })
    es.addEventListener('done', (e: any) => {
      const { status } = JSON.parse(e.data)
      let msg = ''
      if (status === 'COMPLETED') msg = '✅ Setup complete!'
      else if (status === 'TRAINED') msg = '⏳ Training phase complete. Waiting for approval...'
      else msg = '❌ Job failed.'
      setStreamingLogs(prev => ({ ...prev, [modelId]: [...(prev[modelId] || []), msg] }))
      es.close(); setActiveStream(null); load(tenantId)
    })
    es.onerror = () => { es.close(); setActiveStream(null) }
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

      <div className="page-body" style={{ maxWidth: 860 }}>

      {tab === 'llm' ? (
        loadingSettings ? (
          <div className="skeleton" style={{ height: 400, borderRadius: 12 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Default provider banner */}
            {defaultProvider && (
              <div style={{ padding: '14px 18px', borderRadius: 10, background: 'var(--green-bg)', border: '1px solid var(--green-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Default Provider: </span>
                  <span style={{ fontWeight: 700, color: 'var(--green-dark)' }}>{defaultProvider}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 12 }}>Used by all agents unless overridden per-agent</span>
                </div>
              </div>
            )}

            {/* Provider cards */}
            {PROVIDERS.filter(p => p.kind !== 'local' || isLocalEnv).map(p => (
              <div key={p.id}>
                <ProviderCard provider={p} config={providers[p.id]} tenantId={tenantId} onSaved={() => load(tenantId)} toast={toast} />
                {providers[p.id] && defaultProvider !== p.id && (
                  <button className="btn btn-secondary btn-sm" onClick={() => setDefault(p.id)} style={{ marginTop: 6, fontSize: 11 }}>
                    Set as Default
                  </button>
                )}
              </div>
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
                  <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>{settings?.plan} Plan</span>
                    <a href="#" style={{ fontSize: 13, color: 'var(--green-dark)', fontWeight: 600 }}>Upgrade →</a>
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
            {/* Invite form */}
            <div className="card" style={{ padding: 24 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Invite Team Member</h2>
              <form onSubmit={invite} style={{ display: 'flex', gap: 10 }}>
                <input className="input" type="email" placeholder="colleague@company.com" value={inviteForm.email} onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))} required style={{ flex: 2 }} />
                <select className="input" value={inviteForm.role} onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))} style={{ flex: 1 }}>
                  {['ADMIN', 'BUILDER', 'VIEWER'].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <button className="btn btn-primary btn-sm" type="submit" disabled={inviting} style={{ flexShrink: 0 }}>
                  {inviting ? '⟳' : '+ Invite'}
                </button>
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
                          <button
                            className="btn btn-sm"
                            onClick={() => openLogStream(m.id, true)}
                            style={{ fontSize: 12, background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.2)', display: 'flex', alignItems: 'center', gap: 6 }}
                          >
                            <span style={{ display: 'inline-block', width: 6, height: 6, background: '#10b981', borderRadius: '50%' }}></span>
                            {selectedLog === m.id ? 'Close Stream' : 'Live Stream'}
                          </button>
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
      ) : null}
      </div>
      {ConfirmDialog}
    </div>
  )
}
