'use client'
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { CheckCircle, XCircle, Ban, RefreshCw, Loader2, AlertTriangle } from 'lucide-react'

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
}

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [filter, setFilter] = useState<string>('PENDING')
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

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

  async function approveTenant(tenantId: string) {
    setActionLoading(tenantId)
    try {
      await api.request(`/admin/tenants/${tenantId}/approve`, { method: 'POST' })
      setMsg({ type: 'success', text: 'Tenant approved successfully' })
      loadTenants()
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message })
    } finally {
      setActionLoading(null)
    }
  }

  async function suspendTenant(tenantId: string) {
    const reason = prompt('Reason for suspension:')
    if (!reason) return

    setActionLoading(tenantId)
    try {
      await api.request(`/admin/tenants/${tenantId}/suspend`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      })
      setMsg({ type: 'success', text: 'Tenant suspended' })
      loadTenants()
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message })
    } finally {
      setActionLoading(null)
    }
  }

  async function rejectTenant(tenantId: string) {
    const reason = prompt('Reason for rejection (required):')
    if (!reason) return

    setActionLoading(tenantId)
    try {
      await api.request(`/admin/tenants/${tenantId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      })
      setMsg({ type: 'success', text: 'Tenant rejected' })
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
      setMsg({ type: 'success', text: 'Tenant reactivated' })
      loadTenants()
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message })
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>System Admin - Tenant Management</h1>
        <p className="text-muted">Approve, suspend, or reject organization registrations</p>
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
          <p className="text-muted">Loading tenants...</p>
        </div>
      ) : tenants.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <p className="text-muted">No tenants found</p>
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
                    <div className="text-muted" style={{ fontSize: 12 }}>{tenant.plan}</div>
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
                            className="button-sm"
                            style={{ fontSize: 12 }}
                          >
                            {actionLoading === tenant.id ? <Loader2 size={12} className="spin" /> : <CheckCircle size={12} />}
                            Approve
                          </button>
                          <button
                            onClick={() => rejectTenant(tenant.id)}
                            disabled={actionLoading === tenant.id}
                            className="button-sm button-secondary"
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
                          className="button-sm button-secondary"
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
                          className="button-sm"
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
    </div>
  )
}
