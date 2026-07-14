'use client'
import { useEffect, useState } from 'react'
import { useApp } from '@/lib/context'
import { useConfirm } from '@/components/ConfirmModal'
import RestConnectorForm, { type RestConfig } from '@/components/RestConnectorForm'

const CONNECTORS = [
  {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    description: 'Send messages, create channels, and notify teams automatically.',
    category: 'Communication',
    // Slack is OAuth-first, but also accepts a bot token (xoxb-...) pasted
    // directly — set `hasApiKeyFallback` and the modal shows both options.
    authType: 'OAUTH',
    hasApiKeyFallback: true,
    fallbackLabel: 'Or paste a Slack bot token',
    fallbackFields: [
      { name: 'token', label: 'Bot Token', type: 'password', placeholder: 'xoxb-...' },
    ],
    docsUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'jira',
    name: 'Jira',
    icon: '📋',
    description: 'Create, update, and track Jira issues from agent workflows.',
    category: 'Project Management',
    authType: 'API_KEY',
    fields: [
      { name: 'apiKey', label: 'API Token', type: 'password', placeholder: 'ATATT3x...' },
      { name: 'baseUrl', label: 'Jira Base URL', type: 'text', placeholder: 'https://yourorg.atlassian.net' },
      { name: 'email', label: 'Email', type: 'email', placeholder: 'admin@yourorg.com' },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    description: 'Manage repositories, PRs, and issues with AI-powered automation.',
    category: 'Developer Tools',
    authType: 'API_KEY',
    fields: [
      { name: 'token', label: 'Personal Access Token', type: 'password', placeholder: 'ghp_...' },
    ],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    icon: '📧',
    description: 'Read, draft, and send emails on behalf of your team.',
    category: 'Communication',
    authType: 'OAUTH',
    docsUrl: 'https://console.cloud.google.com',
  },
  {
    id: 'notion',
    name: 'Notion',
    icon: '📝',
    description: 'Create pages, update databases, and manage workspace content.',
    category: 'Productivity',
    authType: 'API_KEY',
    fields: [
      { name: 'apiKey', label: 'Integration Secret', type: 'password', placeholder: 'secret_...' },
    ],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    icon: '☁️',
    description: 'Query and update CRM records, contacts, and opportunities.',
    category: 'CRM',
    authType: 'OAUTH',
    docsUrl: 'https://login.salesforce.com',
  },
  {
    id: 'linear',
    name: 'Linear',
    icon: '🔷',
    description: 'Create and update Linear issues from agent task outputs.',
    category: 'Project Management',
    authType: 'API_KEY',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', placeholder: 'lin_api_...' },
    ],
  },
  {
    id: 'webhook',
    name: 'Custom Webhook',
    icon: '🔗',
    description: 'Send structured payloads to any HTTP endpoint on agent events.',
    category: 'Custom',
    authType: 'API_KEY',
    fields: [
      { name: 'url', label: 'Endpoint URL', type: 'text', placeholder: 'https://your.api/webhook' },
      { name: 'secret', label: 'Signing Secret (optional)', type: 'password', placeholder: 'whsec_...' },
    ],
  },
  {
    id: 'database',
    name: 'SQL Database',
    icon: '🗄️',
    description: 'Read-only SQL access for PostgreSQL, MySQL or MariaDB so agents can answer questions grounded in your data.',
    category: 'Data',
    authType: 'API_KEY',
    fields: [
      { name: 'flavor',   label: 'Database type',     type: 'select',   options: [
          { value: 'postgres', label: 'PostgreSQL' },
          { value: 'mysql',    label: 'MySQL' },
          { value: 'mariadb',  label: 'MariaDB' },
      ], defaultValue: 'postgres' },
      { name: 'host',     label: 'Host',              type: 'text',     placeholder: 'db.example.com' },
      { name: 'port',     label: 'Port',              type: 'text',     placeholder: '5432 (pg) / 3306 (mysql)' },
      { name: 'database', label: 'Database name',     type: 'text',     placeholder: 'app_production' },
      { name: 'user',     label: 'User',              type: 'text',     placeholder: 'kuvalam_readonly' },
      { name: 'password', label: 'Password',          type: 'password', placeholder: '••••••••' },
      { name: 'ssl',      label: 'SSL mode (optional)', type: 'text',   placeholder: 'require | strict | disable', optional: true },
    ],
  },
  {
    id: 'rest',
    name: 'Generic REST API',
    icon: '🌐',
    description: 'Point at any HTTP API. Define baseUrl, auth, and one operation per endpoint — each becomes a tool your agents can call.',
    category: 'Custom',
    authType: 'API_KEY',
    // No `fields` — this connector uses a bespoke form (RestConnectorForm).
    fields: [],
  },
]

export default function ConnectorsPage() {
  const { tenantId, toast } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()
  const [activeConnections, setActiveConnections] = useState<any[]>([])
  const [configuring, setConfiguring] = useState<typeof CONNECTORS[0] | null>(null)
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [restConfig, setRestConfig] = useState<RestConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, 'ok' | 'fail'>>({})

  const [loadingOauth, setLoadingOauth] = useState(false)

  // BYOC — per-tenant OAuth app credentials the user pastes in the popup.
  // When the API returns OAUTH_APP_NOT_CONFIGURED, we surface a form asking
  // for Client ID / Client Secret rather than falling back to env vars.
  const [oauthAppForm, setOauthAppForm] = useState<{
    show: boolean
    provider: string       // backend provider (google, slack, jira, microsoft, salesforce)
    redirectUri: string
    clientId: string
    clientSecret: string
    saving: boolean
  } | null>(null)

  useEffect(() => {
    if (tenantId) loadConnectors(tenantId)

    // Handle OAuth Callback responses
    const params = new URLSearchParams(window.location.search)
    if (params.get('success') === 'true') {
      toast('success', 'Integration connected!', 'Your connector is now active.')
      window.history.replaceState({}, document.title, window.location.pathname)
    } else if (params.get('error')) {
      toast('error', 'OAuth failed', params.get('error') || 'Connection failed')
      window.history.replaceState({}, document.title, window.location.pathname)
    }
  }, [tenantId])

  // Close the config modal on Escape — matches how the rest of the app
  // handles overlay dismissal.
  useEffect(() => {
    if (!configuring) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setConfiguring(null); setRestConfig(null); setOauthAppForm(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [configuring])

  async function initiateOAuthFlow(providerId: string) {
    setLoadingOauth(true)
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
      const res = await fetch(`${API_BASE}/tenants/${tenantId}/connectors/oauth/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider: providerId, service: 'default' })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // No OAuth app registered for this tenant — open the BYOC form
        // so the user can paste their Client ID / Client Secret without
        // ever setting an env var. The server tells us which BACKEND
        // provider needs credentials (e.g. 'gmail' UI id → 'google' app).
        if (data?.error?.code === 'OAUTH_APP_NOT_CONFIGURED') {
          const details = data.error.details || {}
          setOauthAppForm({
            show: true,
            provider: details.provider || providerId,
            redirectUri: details.redirectUri || `${API_BASE.replace(/\/api\/v1$/, '')}/api/v1/oauth/callback`,
            clientId: '',
            clientSecret: '',
            saving: false
          })
          toast('info', 'One-time setup required',
            `Paste your ${details.provider || providerId} OAuth Client ID and Secret to continue. Nothing is stored in env vars.`)
          return
        }
        // Surface the exact server error message so misconfigurations
        // (missing client ID, unknown provider, etc.) are actionable.
        const msg = data?.error?.message || `Failed to initiate OAuth (HTTP ${res.status})`
        throw new Error(msg)
      }
      const authUrl = data.data?.authorizationUrl
      if (authUrl) { window.location.href = authUrl }
      else throw new Error('No authorization URL returned from server')
    } catch (err: any) {
      toast('error', 'OAuth failed', err.message)
    } finally {
      setLoadingOauth(false)
    }
  }

  async function saveTenantOAuthApp() {
    if (!oauthAppForm || !configuring) return
    setOauthAppForm(f => f && { ...f, saving: true })
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
      const res = await fetch(`${API_BASE}/tenants/${tenantId}/oauth/apps/${oauthAppForm.provider}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          clientId: oauthAppForm.clientId.trim(),
          clientSecret: oauthAppForm.clientSecret,
          redirectUri: oauthAppForm.redirectUri
        })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error?.message || `Failed to save (HTTP ${res.status})`)
      // Immediately proceed to the OAuth handshake now that creds exist.
      setOauthAppForm(null)
      await initiateOAuthFlow(configuring.id)
    } catch (err: any) {
      toast('error', 'Could not save OAuth app', err.message)
      setOauthAppForm(f => f && { ...f, saving: false })
    }
  }

  async function loadConnectors(tid: string) {
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
      const res = await fetch(`${API_BASE}/tenants/${tid}/connectors`, {
        credentials: 'include'
      })
      if (res.ok) {
        const data = await res.json()
        setActiveConnections(data.data?.connectors || data.data || [])
      }
    } catch { /* API may not have this endpoint yet */ }
  }

  function isConnected(toolId: string) {
    return activeConnections.some(c => c.tool_id === toolId && c.status === 'ACTIVE')
  }

  async function saveConnector(e: React.FormEvent, authTypeOverride?: string) {
    e.preventDefault()
    if (!configuring) return
    setSaving(true)
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
      const config = configuring.id === 'rest'
        ? (restConfig || { baseUrl: '', auth: { type: 'none' }, operations: [] })
        : formValues
      await fetch(`${API_BASE}/tenants/${tenantId}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          toolId: configuring.id,
          name: configuring.id === 'rest' && (restConfig?.baseUrl)
            ? `REST · ${new URL(restConfig!.baseUrl).host}`
            : configuring.name,
          authType: authTypeOverride || configuring.authType,
          config,
        })
      })
      setConfiguring(null)
      setFormValues({})
      setRestConfig(null)
      loadConnectors(tenantId)
      // Connectors start as PENDING; the Test button promotes them to ACTIVE.
      toast('info', 'Credentials saved', `Click "Test" on ${configuring?.name} to verify and activate it.`)
    } catch (err: any) {
      toast('error', 'Save failed', err.message)
    } finally {
      setSaving(false)
    }
  }

  async function removeConnector(connectorId: string) {
    const conn = activeConnections.find(c => c.id === connectorId)
    const ok = await confirm({
      title: `Remove ${conn?.name || 'this connector'}?`,
      description: 'Agents and workflows that use this connector will fail on their next run.',
      confirmLabel: 'Remove connector',
      variant: 'danger',
    })
    if (!ok) return
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
      await fetch(`${API_BASE}/tenants/${tenantId}/connectors/${connectorId}`, {
        method: 'DELETE',
        credentials: 'include'
      })
      loadConnectors(tenantId)
      toast('info', 'Connector removed', '')
    } catch { /* silent */ }
  }

  async function testConnector(connectorId: string) {
    setTesting(connectorId)
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
      const res = await fetch(`${API_BASE}/tenants/${tenantId}/connectors/${connectorId}/test`, {
        method: 'POST',
        credentials: 'include'
      })
      const payload = await res.json().catch(() => ({}))
      const result = payload?.data
      // The API returns { data: { success, message } }; use `success` — a 200
      // response no longer implies a valid connector.
      const ok = res.ok && result?.success === true
      setTestResult(prev => ({ ...prev, [connectorId]: ok ? 'ok' : 'fail' }))
      toast(ok ? 'success' : 'error',
        ok ? 'Connector verified' : 'Connector test failed',
        result?.message || (ok ? 'Connected.' : 'Check credentials or provider settings.'))
      // Refresh so the badge reflects the new ACTIVE / ERROR status.
      loadConnectors(tenantId)
    } catch (err: any) {
      setTestResult(prev => ({ ...prev, [connectorId]: 'fail' }))
      toast('error', 'Connector test failed', err.message)
    } finally {
      setTesting(null)
    }
  }

  const categories = [...new Set(CONNECTORS.map(c => c.category))]

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">Connect your stack so agents can take action, and browse the tools they can use</p>
        </div>
        {activeConnections.length > 0 && (
          <span className="badge badge-active">
            {activeConnections.filter(c => c.status === 'ACTIVE').length} / {activeConnections.length} Active
          </span>
        )}
      </div>

      <div className="tab-bar" style={{ marginTop: 20 }}>
        <a href="/dashboard/connectors" className="tab-bar-item active">Providers</a>
        <a href="/dashboard/tools" className="tab-bar-item">Tools & MCP</a>
      </div>

      <div className="page-body">
        {/* How Connectors relate to Tools */}
        <div className="card" style={{ padding: 14, marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--bg)', border: '1px solid var(--border)' }}>
          <span style={{ fontSize: 18 }}>ℹ️</span>
          <div style={{ fontSize: 13, color: 'var(--text-sub)', lineHeight: 1.5 }}>
            <strong>Providers are stored credentials</strong> — think of them as the account your agent acts through.
            Once a provider is <em>Active</em> (passes the Test), the matching tools show up on the
            <a href="/dashboard/tools" style={{ color: 'var(--green-dark)' }}> Tools & MCP</a> tab and become
            callable by every agent on this tenant. New providers start as <em>Pending</em> until they pass the Test.
          </div>
        </div>
        {/* Configured Connections (Active + Pending + Error) */}
        {activeConnections.length > 0 && (
          <div className="card" style={{ padding: 24, marginBottom: 28 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Configured Connections</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activeConnections.map(conn => {
                const def = CONNECTORS.find(c => c.id === conn.tool_id)
                const statusColor =
                  conn.status === 'ACTIVE'  ? { bg: '#d1fae5', fg: '#065f46', label: '● Active'  } :
                  conn.status === 'ERROR'   ? { bg: '#fecaca', fg: '#991b1b', label: '● Error'   } :
                                              { bg: '#fef3c7', fg: '#92400e', label: '● Pending' }
                return (
                  <div key={conn.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 20 }}>{def?.icon || '🔗'}</span>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{conn.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {new Date(conn.created_at).toLocaleDateString()}
                          {conn.last_tested_at && ` · Last tested: ${new Date(conn.last_tested_at).toLocaleDateString()}`}
                        </div>
                        {conn.status === 'ERROR' && conn.last_error && (
                          <div style={{ fontSize: 11, color: '#991b1b', marginTop: 2 }}>{conn.last_error}</div>
                        )}
                        {conn.status === 'PENDING' && (
                          <div style={{ fontSize: 11, color: '#92400e', marginTop: 2 }}>Click "Test" to verify credentials and activate.</div>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: statusColor.bg, color: statusColor.fg }}>
                        {statusColor.label}
                      </span>
                      <button className="btn btn-secondary btn-sm" disabled={testing === conn.id}
                        onClick={() => testConnector(conn.id)}>
                        {testing === conn.id ? '...' : 'Test'}
                      </button>
                      <button className="btn btn-sm" onClick={() => removeConnector(conn.id)}
                        style={{ background: '#FEF2F2', color: '#dc2626', border: '1px solid #FECACA' }}>Remove</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Connector Catalogue by Category */}
        {categories.map(category => (
          <div key={category} style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 14 }}>
              {category}
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
              {CONNECTORS.filter(c => c.category === category).map(connector => {
                const connected = isConnected(connector.id)
                return (
                  <div key={connector.id} className="card card-hover" style={{ padding: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 12 }}>
                      <span style={{ fontSize: 32, lineHeight: 1 }}>{connector.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <h3 style={{ fontSize: 15, fontWeight: 800 }}>{connector.name}</h3>
                          {connected && <span className="badge badge-active" style={{ fontSize: 9 }}>Connected</span>}
                        </div>
                        <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{connector.description}</p>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {connected ? (
                        <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}
                          onClick={() => setConfiguring(connector)}>
                          Reconfigure
                        </button>
                      ) : (
                        <button className="btn btn-primary btn-sm" style={{ flex: 1 }}
                          onClick={() => {
                            setConfiguring(connector)
                            // Seed defaults so `select` fields (e.g. flavor) are submitted even if untouched.
                            const seeded: Record<string, string> = {}
                            for (const f of (connector.fields || [])) {
                              const d = (f as { defaultValue?: string }).defaultValue
                              if (d) seeded[f.name] = d
                            }
                            setFormValues(seeded)
                          }}>
                          + Connect
                        </button>
                      )}
                      <span style={{ fontSize: 10, padding: '4px 8px', background: 'var(--bg)', borderRadius: 4, border: '1px solid var(--border)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
                        {connector.authType}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Config Modal */}
      {configuring && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            // Only close when the click hits the backdrop itself
            if (e.target === e.currentTarget) {
              setConfiguring(null); setRestConfig(null); setOauthAppForm(null)
            }
          }}
        >
          <div className="modal" style={{ maxWidth: configuring.id === 'rest' ? 780 : 480 }}>
            <div className="modal-header">
              <h2 className="modal-title">{configuring.icon} Connect {configuring.name}</h2>
              <button onClick={() => { setConfiguring(null); setRestConfig(null); setOauthAppForm(null) }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            {configuring.authType === 'OAUTH' ? (
              <>
                <div className="modal-body" style={{ padding: '28px 24px 16px' }}>
                  <div style={{ textAlign: 'center', marginBottom: 20 }}>
                    <div style={{ fontSize: 44, marginBottom: 12 }}>{configuring.icon}</div>
                    <p style={{ color: 'var(--text-sub)', margin: 0, lineHeight: 1.6, fontSize: 13 }}>
                      {configuring.name} uses OAuth 2.0. You'll be redirected to {configuring.name} to grant access, then bounced back here.
                    </p>
                    <p style={{ color: 'var(--text-muted)', margin: '10px 0 0', fontSize: 11, lineHeight: 1.5 }}>
                      Being signed into {configuring.name} in your browser isn't enough &mdash; you have to grant this app explicit permission from here.
                    </p>
                  </div>

                  {oauthAppForm?.show ? (
                    // BYOC form — collect Client ID / Secret in the popup so
                    // production installs never require .env-based secrets.
                    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                        Register your OAuth app
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
                        Create an OAuth 2.0 Client in the {configuring.name} developer console,
                        then paste the Client ID and Client Secret below. Add the redirect URI
                        shown here to the app's allowed redirect list.
                      </p>
                      <div className="form-group" style={{ marginBottom: 10 }}>
                        <label className="form-label" style={{ fontSize: 11 }}>Authorised redirect URI (copy into provider console)</label>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input className="input" readOnly value={oauthAppForm.redirectUri}
                            style={{ fontSize: 11, fontFamily: 'monospace' }} onFocus={e => e.currentTarget.select()} />
                          <button type="button" className="btn btn-secondary btn-sm"
                            onClick={() => { navigator.clipboard?.writeText(oauthAppForm.redirectUri); toast('success', 'Copied', 'Redirect URI copied to clipboard') }}>
                            Copy
                          </button>
                        </div>
                      </div>
                      <div className="form-group" style={{ marginBottom: 10 }}>
                        <label className="form-label" style={{ fontSize: 11 }}>Client ID</label>
                        <input
                          className="input"
                          type="text"
                          autoFocus
                          placeholder="e.g. 123456789-abc.apps.googleusercontent.com"
                          value={oauthAppForm.clientId}
                          onChange={e => setOauthAppForm(f => f && { ...f, clientId: e.target.value })}
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 14 }}>
                        <label className="form-label" style={{ fontSize: 11 }}>Client Secret</label>
                        <input
                          className="input"
                          type="password"
                          placeholder="Stored encrypted (AES-256-GCM)"
                          value={oauthAppForm.clientSecret}
                          onChange={e => setOauthAppForm(f => f && { ...f, clientSecret: e.target.value })}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="btn btn-secondary" style={{ flex: 1 }}
                          onClick={() => setOauthAppForm(null)} disabled={oauthAppForm.saving}>
                          Cancel
                        </button>
                        <button type="button" className="btn btn-primary" style={{ flex: 1 }}
                          onClick={saveTenantOAuthApp}
                          disabled={oauthAppForm.saving || !oauthAppForm.clientId.trim() || !oauthAppForm.clientSecret}>
                          {oauthAppForm.saving ? 'Saving…' : 'Save & Authorise →'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => initiateOAuthFlow(configuring.id)}
                        className="btn btn-primary"
                        disabled={loadingOauth}
                        style={{ width: '100%', justifyContent: 'center' }}
                      >
                        {loadingOauth ? 'Initiating...' : `Authorise with ${configuring.name} →`}
                      </button>
                      {configuring.docsUrl && (
                        <div style={{ textAlign: 'center', marginTop: 10 }}>
                          <a href={configuring.docsUrl} target="_blank" rel="noreferrer"
                             style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            Setup guide ↗
                          </a>
                        </div>
                      )}
                    </>
                  )}

                  {(configuring as { hasApiKeyFallback?: boolean }).hasApiKeyFallback && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '20px 0 14px' }}>
                        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>OR</span>
                        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                      </div>
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault()
                          await saveConnector(e, 'API_KEY')
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-sub)', marginBottom: 10 }}>
                          {(configuring as { fallbackLabel?: string }).fallbackLabel || 'Paste an API token instead'}
                        </div>
                        {((configuring as { fallbackFields?: Array<{ name: string; label: string; type: string; placeholder?: string }> }).fallbackFields || []).map(field => (
                          <div key={field.name} className="form-group" style={{ marginBottom: 12 }}>
                            <label className="form-label">{field.label}</label>
                            <input
                              className="input"
                              type={field.type}
                              placeholder={field.placeholder}
                              value={formValues[field.name] || ''}
                              onChange={ev => setFormValues(v => ({ ...v, [field.name]: ev.target.value }))}
                              required
                            />
                          </div>
                        ))}
                        <button type="submit" className="btn btn-secondary btn-sm" disabled={saving} style={{ width: '100%', justifyContent: 'center' }}>
                          {saving ? 'Saving...' : 'Save token & connect'}
                        </button>
                      </form>
                    </>
                  )}
                </div>
              </>
            ) : configuring.id === 'rest' ? (
              <form onSubmit={saveConnector}>
                <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                    Configure a REST API. Each operation you define becomes a callable tool for your agents.
                  </p>
                  <RestConnectorForm
                    initial={restConfig || undefined}
                    onChange={setRestConfig}
                  />
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-secondary" onClick={() => { setConfiguring(null); setRestConfig(null) }}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={saving || !restConfig?.baseUrl || (restConfig?.operations?.length || 0) === 0}>
                    {saving ? 'Saving...' : 'Save Connection'}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={saveConnector}>
                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    Enter your {configuring.name} credentials. They are stored encrypted and only used server-side.
                  </p>
                  {configuring.fields?.map(field => (
                    <div key={field.name} className="form-group">
                      <label className="form-label">{field.label}</label>
                      {field.type === 'select' ? (
                        <select
                          className="input"
                          value={formValues[field.name] || (field as { defaultValue?: string }).defaultValue || ''}
                          onChange={e => setFormValues(v => ({ ...v, [field.name]: e.target.value }))}
                          required={!(field as { optional?: boolean }).optional}
                        >
                          {((field as { options?: { value: string; label: string }[] }).options || []).map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="input"
                          type={field.type}
                          placeholder={field.placeholder}
                          value={formValues[field.name] || ''}
                          onChange={e => setFormValues(v => ({ ...v, [field.name]: e.target.value }))}
                          required={!(field as { optional?: boolean }).optional}
                        />
                      )}
                    </div>
                  ))}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-secondary" onClick={() => setConfiguring(null)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    {saving ? 'Saving...' : 'Save Connection'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  )
}
