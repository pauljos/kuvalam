'use client'
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import { usePrompt } from '@/components/PromptModal'
import { CheckCircle, XCircle, Ban, RefreshCw, Loader2, AlertTriangle, Building2, Users, Plus, Edit } from 'lucide-react'

interface Tenant {
  id: string
  name: string
  slug: string
  plan: string
  status: string
  approval_status: string
  created_at: string
  owner_email: string
  owner_name: string
  rejection_reason?: string
  member_count?: number
}

export default function AdminTenantsPage() {
  const { user } = useApp()
  const { prompt, PromptDialog } = usePrompt()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [filter, setFilter] = useState<string>('PENDING')
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Redirect non-admin users away from the system portal
  useEffect(() => {
    if (user && !user.isSystemAdmin) window.location.href = '/dashboard'
  }, [user])

  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', slug: '', ownerEmail: '', ownerName: '', plan: 'FREE', password: '' })
  const [showPassword, setShowPassword] = useState(false)
  const [editingPlan, setEditingPlan] = useState<string | null>(null)
  const [newPlan, setNewPlan] = useState<string>('')

  async function loadTenants() {
    setLoading(true)
    setMsg(null)
    try {
      const data = await api.request(`/admin/tenants${filter ? `?status=${filter}` : ''}`)
      setTenants(data.tenants || [])
    } catch (err: any) {
      console.error('Admin tenants error:', err)
      setMsg({ 
        type: 'error', 
        text: err.message || 'Failed to load tenants. Please check if you have system admin access.' 
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTenants()
  }, [filter])

  async function createTenant(e: React.FormEvent) {
    e.preventDefault()
    setActionLoading('create')
    try {
      await api.request('/admin/tenants', {
        method: 'POST',
        body: JSON.stringify(createForm)
      })
      setMsg({ type: 'success', text: `Organization "${createForm.name}" created successfully` })
      setShowCreateModal(false)
      setCreateForm({ name: '', slug: '', ownerEmail: '', ownerName: '', plan: 'FREE', password: '' })
      loadTenants()
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || 'Failed to create organization' })
    } finally {
      setActionLoading(null)
    }
  }

  async function approveTenant(tenantId: string) {
    setActionLoading(tenantId)
    try {
      await api.request(`/admin/tenants/${tenantId}/approve`, { 
        method: 'POST',
        body: JSON.stringify({})
      })
      setMsg({ type: 'success', text: 'Organization approved successfully' })
      loadTenants()
    } catch (err: any) {
      console.error('Approve tenant error:', err)
      setMsg({ 
        type: 'error', 
        text: err.message || 'Failed to approve organization. Check console for details.' 
      })
    } finally {
      setActionLoading(null)
    }
  }

  async function suspendTenant(tenantId: string) {
    const reason = await prompt({ title: 'Suspend Organization', label: 'Reason for suspension', placeholder: 'e.g. Policy violation, billing issue…', required: true, confirmLabel: 'Suspend' })
    if (!reason) return

    setActionLoading(tenantId)
    try {
      await api.request(`/admin/tenants/${tenantId}/suspend`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      })
      setMsg({ type: 'success', text: 'Organization suspended' })
      loadTenants()
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message })
    } finally {
      setActionLoading(null)
    }
  }

  async function rejectTenant(tenantId: string) {
    const reason = await prompt({ title: 'Reject Organization', label: 'Reason for rejection (required)', placeholder: 'Explain why this organization is being rejected…', required: true, confirmLabel: 'Reject' })
    if (!reason) return

    setActionLoading(tenantId)
    try {
      await api.request(`/admin/tenants/${tenantId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      })
      setMsg({ type: 'success', text: 'Organization rejected' })
      loadTenants()
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message })
    } finally {
      setActionLoading(null)
    }
  }

  async function reactivateTenant(tenantId: string) {
    setActionLoading(tenantId)
    try {
      await api.request(`/admin/tenants/${tenantId}/reactivate`, { method: 'POST' })
      setMsg({ type: 'success', text: 'Organization reactivated' })
      loadTenants()
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message })
    } finally {
      setActionLoading(null)
    }
  }

  async function updatePlan(tenantId: string, plan: string) {
    setActionLoading(tenantId)
    try {
      await api.request(`/admin/tenants/${tenantId}/plan`, {
        method: 'PATCH',
        body: JSON.stringify({ plan })
      })
      setMsg({ type: 'success', text: `Plan updated to ${plan}` })
      setEditingPlan(null)
      loadTenants()
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message })
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="page">
      {PromptDialog}
      <div className="page-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Building2 size={28} />
            Organization Management
          </h1>
          <p className="page-sub">Create, approve, and manage organizations. Org admins can then invite users to their organization.</p>
        </div>
        <button 
          className="btn btn-primary" 
          onClick={() => setShowCreateModal(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <Plus size={16} />
          Create Organization
        </button>
      </div>

      {/* Info Card */}
      <div className="card" style={{ marginBottom: 24, padding: 16, background: 'var(--blue-bg)', border: '1px solid var(--blue-border)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <Users size={20} style={{ color: 'var(--blue)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <strong>How it works:</strong>
            <ol style={{ margin: '8px 0 0 20px', padding: 0 }}>
              <li><strong>System Admin</strong> (you) creates and approves organizations</li>
              <li><strong>Organization Owner</strong> is automatically created when you approve an organization</li>
              <li><strong>Organization Owner/Admin</strong> can then invite additional users (Admin, Builder, Viewer) from their Settings → Members page</li>
            </ol>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Filter:</span>
          {['ALL', 'PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED'].map(status => (
            <button
              key={status}
              onClick={() => setFilter(status === 'ALL' ? '' : status)}
              className={filter === (status === 'ALL' ? '' : status) ? 'button' : 'button-secondary'}
              style={{ fontSize: 13 }}
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <div className={`alert alert-${msg.type}`} style={{ marginBottom: 24 }}>
          {msg.type === 'error' ? <AlertTriangle size={16} /> : <CheckCircle size={16} />}
          {msg.text}
          <button onClick={() => setMsg(null)} className="alert-close">×</button>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Loader2 size={24} className="spin" style={{ margin: '0 auto 12px' }} />
          <p className="text-muted">Loading organizations...</p>
        </div>
      ) : tenants.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Building2 size={48} style={{ margin: '0 auto 16px', opacity: 0.3 }} />
          <p className="text-muted">No organizations found</p>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreateModal(true)} style={{ marginTop: 16 }}>
            <Plus size={14} /> Create First Organization
          </button>
        </div>
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Owner</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map(tenant => (
                <tr key={tenant.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{tenant.name}</div>
                    {editingPlan === tenant.id ? (
                      <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
                        <select 
                          className="input" 
                          style={{ fontSize: 11, padding: '2px 6px', height: 'auto' }}
                          value={newPlan}
                          onChange={e => setNewPlan(e.target.value)}
                        >
                          <option value="TRIAL">TRIAL</option>
                          <option value="FREE">FREE</option>
                          <option value="PRO">PRO</option>
                          <option value="ENTERPRISE">ENTERPRISE</option>
                        </select>
                        <button 
                          className="btn-sm"
                          style={{ fontSize: 10, padding: '2px 8px' }}
                          onClick={() => updatePlan(tenant.id, newPlan)}
                          disabled={actionLoading === tenant.id}
                        >
                          {actionLoading === tenant.id ? '⟳' : '✓'}
                        </button>
                        <button 
                          className="btn-sm btn-secondary" 
                          style={{ fontSize: 10, padding: '2px 8px' }}
                          onClick={() => setEditingPlan(null)}
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4 }}>
                        <span className={`badge badge-${
                          tenant.plan === 'ENTERPRISE' ? 'success' :
                          tenant.plan === 'PRO' ? 'primary' :
                          tenant.plan === 'FREE' ? 'default' : 'warning'
                        }`} style={{ fontSize: 10 }}>
                          {tenant.plan}
                        </span>
                        <button 
                          onClick={() => { setEditingPlan(tenant.id); setNewPlan(tenant.plan) }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}
                          title="Edit plan"
                        >
                          <Edit size={12} />
                        </button>
                      </div>
                    )}
                  </td>
                  <td>
                    <div>{tenant.owner_name}</div>
                    <div className="text-muted" style={{ fontSize: 12 }}>{tenant.owner_email}</div>
                  </td>
                  <td><code>{tenant.slug}</code></td>
                  <td>
                    <span className={`badge badge-${
                      tenant.approval_status === 'APPROVED' ? 'success' :
                      tenant.approval_status === 'PENDING' ? 'warning' :
                      tenant.approval_status === 'SUSPENDED' ? 'error' : 'default'
                    }`}>
                      {tenant.approval_status}
                    </span>
                    {tenant.rejection_reason && (
                      <div className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {tenant.rejection_reason}
                      </div>
                    )}
                  </td>
                  <td className="text-muted" style={{ fontSize: 13 }}>
                    {new Date(tenant.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {tenant.approval_status === 'PENDING' && (
                        <>
                          <button
                            onClick={() => approveTenant(tenant.id)}
                            disabled={actionLoading === tenant.id}
                            className="btn-sm"
                            style={{ fontSize: 12 }}
                          >
                            {actionLoading === tenant.id ? <Loader2 size={12} className="spin" /> : <CheckCircle size={12} />}
                            Approve
                          </button>
                          <button
                            onClick={() => rejectTenant(tenant.id)}
                            disabled={actionLoading === tenant.id}
                            className="btn-sm btn-secondary"
                            style={{ fontSize: 12 }}
                          >
                            <XCircle size={12} />
                            Reject
                          </button>
                        </>
                      )}
                      {tenant.approval_status === 'APPROVED' && (
                        <button
                          onClick={() => suspendTenant(tenant.id)}
                          disabled={actionLoading === tenant.id}
                          className="btn-sm btn-secondary"
                          style={{ fontSize: 12 }}
                        >
                          <Ban size={12} />
                          Suspend
                        </button>
                      )}
                      {tenant.approval_status === 'SUSPENDED' && (
                        <button
                          onClick={() => reactivateTenant(tenant.id)}
                          disabled={actionLoading === tenant.id}
                          className="btn-sm"
                          style={{ fontSize: 12 }}
                        >
                          <RefreshCw size={12} />
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Organization Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h2 className="modal-title">Create Organization</h2>
              <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <form onSubmit={createTenant}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="form-group">
                  <label className="form-label">Organization Name *</label>
                  <input 
                    className="input" 
                    value={createForm.name} 
                    onChange={e => setCreateForm(f => ({ ...f, name: e.target.value, slug: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-') }))} 
                    required 
                    placeholder="Acme Corporation"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Slug (URL-friendly identifier) *</label>
                  <input 
                    className="input" 
                    value={createForm.slug} 
                    onChange={e => setCreateForm(f => ({ ...f, slug: e.target.value }))} 
                    required 
                    pattern="[a-z0-9-]+"
                    placeholder="acme-corp"
                  />
                  <p className="form-hint">Lowercase letters, numbers, and hyphens only</p>
                </div>
                <div className="form-group">
                  <label className="form-label">Owner Name *</label>
                  <input 
                    className="input" 
                    value={createForm.ownerName} 
                    onChange={e => setCreateForm(f => ({ ...f, ownerName: e.target.value }))} 
                    required 
                    placeholder="John Doe"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Owner Email *</label>
                  <input 
                    className="input" 
                    type="email"
                    value={createForm.ownerEmail} 
                    onChange={e => setCreateForm(f => ({ ...f, ownerEmail: e.target.value }))} 
                    required 
                    placeholder="john@acme.com"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">
                    Owner Password
                    <span className="text-muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>(optional — leave blank to send invite)</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input 
                      className="input" 
                      type={showPassword ? 'text' : 'password'}
                      value={createForm.password} 
                      onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))} 
                      minLength={8}
                      placeholder="Set password directly"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="button-sm button-secondary"
                      onClick={() => setShowPassword(p => !p)}
                      style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <p className="form-hint">
                    {createForm.password ? '✓ Password will be set directly — owner can sign in immediately' : 'Owner will receive an invite to set their password'}
                  </p>
                </div>
                <div className="form-group">
                  <label className="form-label">Plan</label>
                  <select 
                    className="input" 
                    value={createForm.plan} 
                    onChange={e => setCreateForm(f => ({ ...f, plan: e.target.value }))}
                  >
                    <option value="FREE">Free</option>
                    <option value="PRO">Pro</option>
                    <option value="ENTERPRISE">Enterprise</option>
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={actionLoading === 'create'}>
                  {actionLoading === 'create' ? '⟳ Creating...' : 'Create Organization'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
