'use client'
/**
 * RestConnectorForm — configure a generic REST connector.
 *
 * Persists a config shape understood by the backend's `verifyRestConnector` +
 * `executeRestTool`:
 *   {
 *     baseUrl, auth: {...}, defaultHeaders?, healthCheck?, operations: [...]
 *   }
 * Each operation defines a discrete tool the LLM can call.
 */
import { useState } from 'react'
import { Trash2, Plus } from 'lucide-react'

export interface RestParam {
  name: string
  in: 'path' | 'query' | 'header'
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
}

export interface RestOp {
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  path: string
  description?: string
  params: RestParam[]
  bodyType?: 'json' | 'form' | 'raw'
}

export interface RestConfig {
  baseUrl: string
  auth: {
    type: 'none' | 'bearer' | 'basic' | 'header' | 'query'
    token?: string
    username?: string
    password?: string
    headerName?: string
    headerValue?: string
    queryName?: string
    queryValue?: string
  }
  defaultHeaders?: Record<string, string>
  healthCheck?: { method: string; path: string }
  operations: RestOp[]
}

interface Props {
  initial?: Partial<RestConfig>
  onChange: (cfg: RestConfig) => void
}

const emptyOp = (): RestOp => ({
  name: '', method: 'GET', path: '/', description: '', params: [], bodyType: 'json'
})

export default function RestConnectorForm({ initial, onChange }: Props) {
  const [cfg, setCfg] = useState<RestConfig>({
    baseUrl: initial?.baseUrl || '',
    auth: initial?.auth || { type: 'none' },
    defaultHeaders: initial?.defaultHeaders || {},
    healthCheck: initial?.healthCheck,
    operations: initial?.operations || [],
  })

  function push(next: RestConfig) {
    setCfg(next)
    onChange(next)
  }

  function updateOp(idx: number, patch: Partial<RestOp>) {
    push({ ...cfg, operations: cfg.operations.map((o, i) => i === idx ? { ...o, ...patch } : o) })
  }
  function addOp() { push({ ...cfg, operations: [...cfg.operations, emptyOp()] }) }
  function removeOp(idx: number) { push({ ...cfg, operations: cfg.operations.filter((_, i) => i !== idx) }) }

  function updateParam(opIdx: number, pIdx: number, patch: Partial<RestParam>) {
    updateOp(opIdx, { params: cfg.operations[opIdx].params.map((p, i) => i === pIdx ? { ...p, ...patch } : p) })
  }
  function addParam(opIdx: number) {
    updateOp(opIdx, { params: [...cfg.operations[opIdx].params, { name: '', in: 'query', type: 'string' }] })
  }
  function removeParam(opIdx: number, pIdx: number) {
    updateOp(opIdx, { params: cfg.operations[opIdx].params.filter((_, i) => i !== pIdx) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="form-group">
        <label className="form-label">Base URL *</label>
        <input className="input" placeholder="https://api.example.com/v1" value={cfg.baseUrl} onChange={e => push({ ...cfg, baseUrl: e.target.value })} required />
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Operation paths are appended to this base. Private/internal hosts are rejected in production.</p>
      </div>

      {/* Auth */}
      <div className="form-group">
        <label className="form-label">Authentication</label>
        <select className="select" value={cfg.auth.type} onChange={e => push({ ...cfg, auth: { type: e.target.value as any } })}>
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic (username + password)</option>
          <option value="header">Custom header</option>
          <option value="query">Query string parameter</option>
        </select>
      </div>

      {cfg.auth.type === 'bearer' && (
        <div className="form-group">
          <label className="form-label">Token</label>
          <input className="input" type="password" value={cfg.auth.token || ''} onChange={e => push({ ...cfg, auth: { ...cfg.auth, token: e.target.value } })} placeholder="sk_live_..." />
        </div>
      )}

      {cfg.auth.type === 'basic' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="form-group">
            <label className="form-label">Username</label>
            <input className="input" value={cfg.auth.username || ''} onChange={e => push({ ...cfg, auth: { ...cfg.auth, username: e.target.value } })} />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input className="input" type="password" value={cfg.auth.password || ''} onChange={e => push({ ...cfg, auth: { ...cfg.auth, password: e.target.value } })} />
          </div>
        </div>
      )}

      {cfg.auth.type === 'header' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
          <div className="form-group">
            <label className="form-label">Header name</label>
            <input className="input" value={cfg.auth.headerName || ''} onChange={e => push({ ...cfg, auth: { ...cfg.auth, headerName: e.target.value } })} placeholder="X-Api-Key" />
          </div>
          <div className="form-group">
            <label className="form-label">Header value</label>
            <input className="input" type="password" value={cfg.auth.headerValue || ''} onChange={e => push({ ...cfg, auth: { ...cfg.auth, headerValue: e.target.value } })} />
          </div>
        </div>
      )}

      {cfg.auth.type === 'query' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
          <div className="form-group">
            <label className="form-label">Query param</label>
            <input className="input" value={cfg.auth.queryName || ''} onChange={e => push({ ...cfg, auth: { ...cfg.auth, queryName: e.target.value } })} placeholder="api_key" />
          </div>
          <div className="form-group">
            <label className="form-label">Value</label>
            <input className="input" type="password" value={cfg.auth.queryValue || ''} onChange={e => push({ ...cfg, auth: { ...cfg.auth, queryValue: e.target.value } })} />
          </div>
        </div>
      )}

      {/* Health check */}
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8 }}>
        <div className="form-group">
          <label className="form-label">Test method</label>
          <select className="select" value={cfg.healthCheck?.method || 'GET'} onChange={e => push({ ...cfg, healthCheck: { ...(cfg.healthCheck || { path: '' }), method: e.target.value } })}>
            {['GET', 'POST', 'HEAD'].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Test path (optional)</label>
          <input className="input" placeholder="/health or /me — pinged when you click Test" value={cfg.healthCheck?.path || ''} onChange={e => push({ ...cfg, healthCheck: { method: cfg.healthCheck?.method || 'GET', path: e.target.value } })} />
        </div>
      </div>

      <hr className="divider" />

      {/* Operations */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 700 }}>Operations</h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Each operation becomes a tool the LLM can call.</p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={addOp}>
            <Plus size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Operation
          </button>
        </div>

        {cfg.operations.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)', border: '1.5px dashed var(--border-dark)', borderRadius: 8 }}>
            No operations defined yet. Add at least one before saving.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {cfg.operations.map((op, idx) => (
            <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, background: 'var(--bg)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 2fr auto', gap: 8, alignItems: 'end' }}>
                <div className="form-group">
                  <label className="form-label" style={{ fontSize: 11 }}>Tool name *</label>
                  <input className="input" value={op.name} placeholder="get_user" onChange={e => updateOp(idx, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_') })} />
                </div>
                <div className="form-group">
                  <label className="form-label" style={{ fontSize: 11 }}>Method</label>
                  <select className="select" value={op.method} onChange={e => updateOp(idx, { method: e.target.value as any })}>
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label" style={{ fontSize: 11 }}>Path *</label>
                  <input className="input" value={op.path} placeholder="/users/{id}" onChange={e => updateOp(idx, { path: e.target.value })} />
                </div>
                <button type="button" onClick={() => removeOp(idx)} title="Remove operation" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 6 }}>
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="form-group" style={{ marginTop: 8 }}>
                <label className="form-label" style={{ fontSize: 11 }}>Description (shown to the LLM)</label>
                <input className="input" value={op.description || ''} onChange={e => updateOp(idx, { description: e.target.value })} placeholder="e.g. Fetch a single user by id" />
              </div>

              {/* Params */}
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="form-label" style={{ fontSize: 11 }}>Parameters</label>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => addParam(idx)}>
                    <Plus size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} /> Parameter
                  </button>
                </div>
                {op.params.length === 0 ? (
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>No parameters. Use <code>{'{name}'}</code> in the path for path params.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                    {op.params.map((p, pi) => (
                      <div key={pi} style={{ display: 'grid', gridTemplateColumns: '1.2fr 80px 90px 60px 2fr auto', gap: 6, alignItems: 'center' }}>
                        <input className="input" value={p.name} placeholder="name" onChange={e => updateParam(idx, pi, { name: e.target.value })} />
                        <select className="select" value={p.in} onChange={e => updateParam(idx, pi, { in: e.target.value as any })}>
                          <option value="path">path</option>
                          <option value="query">query</option>
                          <option value="header">header</option>
                        </select>
                        <select className="select" value={p.type} onChange={e => updateParam(idx, pi, { type: e.target.value as any })}>
                          <option value="string">string</option>
                          <option value="number">number</option>
                          <option value="boolean">boolean</option>
                        </select>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                          <input type="checkbox" checked={!!p.required} onChange={e => updateParam(idx, pi, { required: e.target.checked })} /> req
                        </label>
                        <input className="input" value={p.description || ''} placeholder="description (helps the LLM)" onChange={e => updateParam(idx, pi, { description: e.target.value })} />
                        <button type="button" onClick={() => removeParam(idx, pi)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer' }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {['POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method) && (
                <div className="form-group" style={{ marginTop: 8 }}>
                  <label className="form-label" style={{ fontSize: 11 }}>Body encoding</label>
                  <select className="select" value={op.bodyType || 'json'} onChange={e => updateOp(idx, { bodyType: e.target.value as any })} style={{ maxWidth: 200 }}>
                    <option value="json">JSON</option>
                    <option value="form">Form-encoded</option>
                    <option value="raw">Raw string</option>
                  </select>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
