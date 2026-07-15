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
  { id: 'opencode', name: 'OpenCode', icon: '💻', color: '#10b981', models: ['opencode/zen-coder', 'opencode/go-coder-33b', 'deepseek/deepseek-coder', 'qwen/qwen2.5-coder'], keyLabel: 'API Key', keyPlaceholder: 'oc-...', baseUrl: 'https://console.opencode.ai/inference/openai/v1' },
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
            {isLocal && (
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                  Base URL
                </label>
                <input className="input" type="url" placeholder={provider.keyPlaceholder} value={form.baseUrl} onChange={set('baseUrl')} required={!isConfigured} />
                <p className="form-hint">Your OpenAI-compatible endpoint. Must end with <code>/v1</code>.</p>
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
                    {provider.models.map((m: string) => <option key={m} value={m}>{m}</option>)}
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

  const TABS = [{ id: 'llm', label: 'LLM Providers' }, { id: 'general', label: 'General' }, { id: 'members', label: 'Members' }]

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
            {PROVIDERS.map(p => (
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
      ) : (
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
      )}
      </div>
    </div>
  )
}
