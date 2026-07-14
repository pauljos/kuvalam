'use client'
import { useEffect, useState } from 'react'
import { useApp } from '@/lib/context'
import { api } from '@/lib/api'
import Link from 'next/link'
import { useConfirm } from '@/components/ConfirmModal'

// Tools that are ALWAYS available to every agent on every task (wired directly
// into apps/api/src/services/task.service.js executeTool). These require no
// per-tenant configuration.
const BUILTIN_TOOLS = [
  { id: 'http_request', name: 'HTTP Request', icon: '🌐', category: 'Core', description: 'Make GET/POST/PUT/PATCH/DELETE calls to any public HTTP(S) endpoint.', enabled: true },
  { id: 'a2a_call',     name: 'A2A Agent Call', icon: '🤝', category: 'Orchestration', description: 'Delegate a sub-goal to another A2A-compatible agent (internal or external).', enabled: true, badge: 'A2A' },
  { id: 'browser_use',  name: 'Browser Use', icon: '🖥️', category: 'Automation', description: 'Drive a real browser to navigate, click, type, extract and screenshot.', enabled: !!process.env.NEXT_PUBLIC_BROWSER_AGENT_URL, requires: 'BROWSER_AGENT_URL env var on the API' },
]

// Tools that appear ONLY when the matching connector on the Connectors page is
// ACTIVE. Displayed here so users can see what actions a given connector unlocks.
const CONNECTOR_BACKED_TOOLS = [
  { id: 'slack__post_message', name: 'Slack: Post Message',   icon: '💬', connectorId: 'slack',   description: 'Post a message to a Slack channel or thread.' },
  { id: 'jira__create_issue',  name: 'Jira: Create Issue',    icon: '📋', connectorId: 'jira',    description: 'Create a Jira issue in the specified project.' },
  { id: 'jira__search_issues', name: 'Jira: Search Issues',   icon: '📋', connectorId: 'jira',    description: 'Run a JQL search against Jira.' },
  { id: 'github__create_issue', name: 'GitHub: Create Issue', icon: '🐙', connectorId: 'github',  description: 'Open a new issue on a GitHub repository.' },
  { id: 'github__search_repos', name: 'GitHub: Search Repos', icon: '🐙', connectorId: 'github',  description: 'Search public GitHub repositories.' },
  { id: 'github__get_repo',     name: 'GitHub: Get Repo',     icon: '🐙', connectorId: 'github',  description: 'Fetch metadata for a specific repository.' },
  { id: 'gmail__send_email',    name: 'Gmail: Send Email',    icon: '📧', connectorId: 'gmail',   description: 'Send an email as the connected Gmail user.' },
  { id: 'webhook__post',        name: 'Webhook: POST',        icon: '🔗', connectorId: 'webhook', description: 'POST a JSON payload (HMAC-signed if a secret is set) to the configured URL.' },
  // Database tools are per-connector (one set per configured DB) and named
  // db__<connIdSlug>__{list_tables|describe_table|sample|query}.
  { id: 'db__…__list_tables',    name: 'DB: List Tables',     icon: '🐘', connectorId: 'postgres', description: 'Enumerate schemas + tables with row-count estimates. One tool per configured database.' },
  { id: 'db__…__describe_table', name: 'DB: Describe Table',  icon: '🐘', connectorId: 'postgres', description: 'Columns, types, primary key, and indexes for a single table.' },
  { id: 'db__…__sample',         name: 'DB: Sample Rows',     icon: '🐘', connectorId: 'postgres', description: 'Return the first N rows from a table (safe preview, max 50).' },
  { id: 'db__…__query',          name: 'DB: Run Query',       icon: '🐘', connectorId: 'postgres', description: 'Read-only SELECT with parameter binding. Multi-statement + DDL/DML rejected; result capped at 200 rows.' },
]

interface McpServer { id: string; name: string; url: string; status: string; tool_count?: number; tools?: string[] }

export default function ToolsPage() {
  const { tenantId, toast } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [connectors, setConnectors] = useState<Array<{ id: string; tool_id: string; name: string; status: string }>>([])
  const [showAddMcp, setShowAddMcp] = useState(false)
  const [mcpForm, setMcpForm] = useState({ name: '', url: '', authToken: '' })
  const [adding, setAdding] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (tenantId) { loadMcpServers(); loadConnectors() }
  }, [tenantId])

  async function loadMcpServers() {
    try {
      const data = await api.listMcpServers(tenantId)
      setMcpServers(data?.servers || [])
    } catch { /* MCP endpoint optional */ }
  }

  async function loadConnectors() {
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
      const res = await fetch(`${API_BASE}/tenants/${tenantId}/connectors`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setConnectors(data.data?.connectors || data.data || [])
      }
    } catch { /* silent */ }
  }

  function connectorActive(toolId: string) {
    return connectors.some(c => c.tool_id === toolId && c.status === 'ACTIVE')
  }

  async function addMcpServer(e: React.FormEvent) {
    e.preventDefault(); setAdding(true)
    try {
      await api.addMcpServer(tenantId, mcpForm)
      toast('success', 'MCP server added', `"${mcpForm.name}" is now connected.`)
      setMcpForm({ name: '', url: '', authToken: '' }); setShowAddMcp(false); loadMcpServers()
    } catch (err: any) { toast('error', 'Failed to add server', err.message)
    } finally { setAdding(false) }
  }

  async function removeMcpServer(id: string, name: string) {
    const ok = await confirm({
      title: `Remove "${name}"?`,
      description: 'Agents that use this MCP server will lose access to its tools. This action cannot be undone.',
      confirmLabel: 'Remove server',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.removeMcpServer(tenantId, id)
      setMcpServers(prev => prev.filter(s => s.id !== id)); toast('info', 'Server removed', '')
    } catch (err: any) { toast('error', 'Remove failed', err.message) }
  }

  const categories = ['All', ...new Set(BUILTIN_TOOLS.map(t => t.category))]
  const filtered = BUILTIN_TOOLS.filter(t =>
    (categoryFilter === 'All' || t.category === categoryFilter) &&
    (t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()))
  )
  const unlockedConnectorTools = CONNECTOR_BACKED_TOOLS.filter(t => connectorActive(t.connectorId))
  const lockedConnectorTools = CONNECTOR_BACKED_TOOLS.filter(t => !connectorActive(t.connectorId))

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">Everything your agents can call during a task run</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddMcp(true)}>+ Add MCP Server</button>
      </div>

      <div className="tab-bar" style={{ marginTop: 20 }}>
        <a href="/dashboard/connectors" className="tab-bar-item">Providers</a>
        <a href="/dashboard/tools" className="tab-bar-item active">Tools & MCP</a>
      </div>

      <div className="page-body">
        <div className="card" style={{ padding: 14, marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--bg)', border: '1px solid var(--border)' }}>
          <span style={{ fontSize: 18 }}>ℹ️</span>
          <div style={{ fontSize: 13, color: 'var(--text-sub)', lineHeight: 1.5 }}>
            This tab shows <strong>what the agent actually sees</strong> at planning time:
            <br />• <strong>Built-in tools</strong> — always available, no configuration.
            <br />• <strong>Connector-backed tools</strong> — appear once the matching provider is <em>Active</em> in the <Link href="/dashboard/connectors" style={{ color: 'var(--green-dark)' }}>Providers</Link> tab.
            <br />• <strong>MCP tools</strong> — exposed by any Model Context Protocol server registered below.
          </div>
        </div>

        <div className="stats-grid" style={{ marginBottom: 24 }}>
          {[
            { label: 'Built-in Tools', value: BUILTIN_TOOLS.filter(t => t.enabled).length, icon: '🛠', color: '#7c3aed' },
            { label: 'Connector Tools', value: unlockedConnectorTools.length, icon: '🔌', color: '#059669' },
            { label: 'MCP Servers', value: mcpServers.length, icon: '📡', color: '#2563eb' },
            { label: 'MCP Tools', value: mcpServers.reduce((n, s) => n + (s.tool_count || 0), 0), icon: '⚡', color: '#d97706' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div style={{ fontSize: 26, fontWeight: 900, color: s.color }}>{s.icon} {s.value}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 28, marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h2 style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>Built-in Agent Tools</h2>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Always available. Wired directly into every agent's tool loop.</p>
            </div>
            <input className="input" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 180, fontSize: 13 }} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {categories.map(cat => (
              <button key={cat} onClick={() => setCategoryFilter(cat)} style={{
                padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${categoryFilter === cat ? 'var(--green)' : 'var(--border)'}`,
                background: categoryFilter === cat ? 'var(--green-bg)' : 'var(--bg-white)',
                color: categoryFilter === cat ? 'var(--green-dark)' : 'var(--text-muted)',
              }}>{cat}</button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {filtered.map(tool => (
              <div key={tool.id} className="card" style={{
                padding: 16, display: 'flex', gap: 12,
                border: tool.enabled ? '1px solid var(--green-border)' : '1px solid var(--border)',
                background: tool.enabled ? 'var(--green-bg)' : 'var(--bg-white)',
              }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>{tool.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{tool.name}</span>
                    {(tool as any).badge && <span style={{ fontSize: 9, padding: '2px 5px', borderRadius: 4, fontWeight: 800, background: '#7c3aed20', color: '#7c3aed' }}>{(tool as any).badge}</span>}
                    <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: tool.enabled ? '#d1fae5' : '#f3f4f6', color: tool.enabled ? '#065f46' : '#9ca3af' }}>{tool.enabled ? 'Active' : 'Off'}</span>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: (tool as any).requires ? 4 : 0 }}>{tool.description}</p>
                  {(tool as any).requires && <div style={{ fontSize: 11, color: '#d97706', fontWeight: 600 }}>Requires: {(tool as any).requires}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Connector-backed tools — visibility mirrors what the agent actually sees */}
        <div className="card" style={{ padding: 28, marginBottom: 24 }}>
          <div style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>Connector-backed Tools</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              These appear in the agent's tool list only when the matching integration is <em>Active</em> in <Link href="/dashboard/connectors" style={{ color: 'var(--green-dark)' }}>Connectors</Link>.
              A locked tool below is invisible to the agent.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {[...unlockedConnectorTools, ...lockedConnectorTools].map(tool => {
              const active = connectorActive(tool.connectorId)
              return (
                <div key={tool.id} className="card" style={{
                  padding: 16, display: 'flex', gap: 12,
                  border: active ? '1px solid var(--green-border)' : '1px solid var(--border)',
                  background: active ? 'var(--green-bg)' : 'var(--bg-white)',
                  opacity: active ? 1 : 0.75,
                }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>{tool.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, fontFamily: 'monospace' }}>{tool.id}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: active ? '#d1fae5' : '#f3f4f6', color: active ? '#065f46' : '#9ca3af' }}>
                        {active ? 'Unlocked' : 'Locked'}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-sub)', marginBottom: 2 }}>{tool.name}</div>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 4 }}>{tool.description}</p>
                    {!active && (
                      <div style={{ fontSize: 11, color: '#d97706', fontWeight: 600 }}>
                        Requires: <Link href="/dashboard/connectors" style={{ color: '#d97706' }}>{tool.connectorId} connector</Link>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="card" style={{ padding: 28 }}>
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>MCP Servers</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Connect any <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--green-dark)' }}>Model Context Protocol</a> server to give agents access to GitHub, databases, APIs and more.</p>
          </div>
          {mcpServers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '36px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 38, marginBottom: 10 }}>🔌</div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>No MCP servers connected</div>
              <div style={{ fontSize: 13, marginBottom: 18 }}>Add an MCP server to give agents access to databases, APIs, and file systems.</div>
              <button className="btn btn-primary" onClick={() => setShowAddMcp(true)}>Connect First MCP Server</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {mcpServers.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderRadius: 10, border: '1px solid var(--green-border)', background: 'var(--green-bg)' }}>
                  <span style={{ fontSize: 26 }}>🔌</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{s.url}</div>
                    {s.tools && s.tools.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{s.tools.slice(0, 5).join(', ')}{s.tools.length > 5 ? ` +${s.tools.length - 5} more` : ''}</div>}
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: s.status === 'ACTIVE' ? '#d1fae5' : '#fecaca', color: s.status === 'ACTIVE' ? '#065f46' : '#991b1b' }}>{s.status}</span>
                  {s.tool_count !== undefined && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.tool_count} tools</span>}
                  <button className="btn btn-secondary btn-sm" onClick={() => removeMcpServer(s.id, s.name)} style={{ color: '#ef4444' }}>Remove</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 24, padding: '16px 20px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, color: 'var(--text-sub)' }}>Popular MCP Servers</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[{ name: 'GitHub MCP', url: 'npx @modelcontextprotocol/server-github', icon: '🐙' },
                { name: 'Postgres MCP', url: 'npx @modelcontextprotocol/server-postgres', icon: '🐘' },
                { name: 'Filesystem MCP', url: 'npx @modelcontextprotocol/server-filesystem', icon: '📁' },
                { name: 'Brave Search', url: 'npx @modelcontextprotocol/server-brave-search', icon: '🦁' },
                { name: 'Puppeteer MCP', url: 'npx @modelcontextprotocol/server-puppeteer', icon: '🎭' }]
                .map(s => (
                  <button key={s.name} onClick={() => { setMcpForm(f => ({ ...f, name: s.name, url: s.url })); setShowAddMcp(true) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-white)', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text-sub)' }}>
                    {s.icon} {s.name}
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>

      {showAddMcp && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <h2 className="modal-title">Connect MCP Server</h2>
              <button onClick={() => setShowAddMcp(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)' }}>✕</button>
            </div>
            <form onSubmit={addMcpServer}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="form-group">
                  <label className="form-label">Server Name *</label>
                  <input className="input" placeholder="e.g. GitHub Tools" value={mcpForm.name} onChange={e => setMcpForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Server URL or Command *</label>
                  <input className="input" placeholder="https://mcp.example.com or npx @org/server" value={mcpForm.url} onChange={e => setMcpForm(f => ({ ...f, url: e.target.value }))} required />
                  <span className="form-hint">HTTP/HTTPS endpoints and stdio command strings are supported.</span>
                </div>
                <div className="form-group">
                  <label className="form-label">Auth Token (optional)</label>
                  <input className="input" type="password" placeholder="Bearer token if required" value={mcpForm.authToken} onChange={e => setMcpForm(f => ({ ...f, authToken: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddMcp(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={adding}>{adding ? 'Connecting...' : 'Connect Server'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  )
}

