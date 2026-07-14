'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'

export default function SystemAdminPortal() {
  const router = useRouter()
  const { toast, user } = useApp()
  const [tenants, setTenants] = useState<any[]>([])
  const [systemStatus, setSystemStatus] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  // Client-side authorization guard. The backend already enforces this via a
  // module-level preHandler on admin.routes.js (returns 403 for non-admins), but
  // without this redirect a non-admin who navigates directly to /dashboard/admin
  // sees a broken page (spinner → error toast) instead of being sent home.
  // Defence-in-depth: never rely on the client alone — the API is the source of truth.
  useEffect(() => {
    // Wait for user hydration from AppProvider before deciding
    if (user === undefined) return
    if (!user || !user.isSystemAdmin) {
      router.replace('/dashboard')
    }
  }, [user, router])

  useEffect(() => {
    if (user?.isSystemAdmin) fetchData()
  }, [user?.isSystemAdmin])

  async function fetchData() {
    setLoading(true)
    try {
      const [tenantsRes, statusRes] = await Promise.all([
        api.getAdminTenants(),
        api.getAdminSystemStatus()
      ])
      setTenants(tenantsRes?.tenants || [])
      setSystemStatus(statusRes || null)
    } catch (err: any) {
      toast('error', 'Load failed', err.message)
    } finally {
      setLoading(false)
    }
  }

  async function updateTenant(tenantId: string, updates: { plan?: string; status?: string }) {
    setUpdatingId(tenantId)
    try {
      const res = await api.updateAdminTenant(tenantId, updates)
      const updatedTenant = res?.tenant
      if (updatedTenant) {
        setTenants(prev => prev.map(t => t.id === tenantId ? { ...t, ...updatedTenant } : t))
      }
    } catch (err: any) {
      toast('error', 'Update failed', err.message)
    } finally {
      setUpdatingId(null)
    }
  }

  // Render nothing while the guard is deciding — avoids a flash of admin UI
  // for a non-admin user before the redirect kicks in.
  if (!user || !user.isSystemAdmin) {
    return null
  }

  return (
    <div className="animate-in" style={{ padding: '32px 40px' }}>
      <div className="page-header" style={{ marginBottom: 32 }}>
        <div>
          <h1 className="page-title">System Portal</h1>
          <p className="page-sub">Global monitoring, tenant provisioning, and system status</p>
        </div>
        <button className="btn btn-primary" onClick={fetchData} disabled={loading}>
          {loading ? '⟳ Refreshing...' : '↻ Refresh Status'}
        </button>
      </div>

      {loading && tenants.length === 0 ? (
        <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <div className="skeleton" style={{ height: 120 }} />
          <div className="skeleton" style={{ height: 120 }} />
          <div className="skeleton" style={{ height: 120 }} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          {/* Global System Metrics */}
          {systemStatus && (
            <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
              {/* Queue Status */}
              <div className="card" style={{ padding: 20 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Task Queue (BullMQ)</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 24, fontWeight: 900, color: systemStatus.queue?.available ? 'var(--green)' : 'var(--text-danger)' }}>
                    {systemStatus.queue?.available ? 'ACTIVE' : 'OFFLINE'}
                  </div>
                  {systemStatus.queue?.available && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      fallback: {systemStatus.queue.isFallback ? 'active' : 'inactive'}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 12, fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div>Agents Queue: <strong>{systemStatus.queue?.agentsCount || 0}</strong></div>
                  <div>Workflows Queue: <strong>{systemStatus.queue?.workflowsCount || 0}</strong></div>
                </div>
              </div>

              {/* Cron Scheduler */}
              <div className="card" style={{ padding: 20 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Cron Scheduler</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 24, fontWeight: 900, color: systemStatus.scheduler?.running ? 'var(--green)' : 'var(--text-muted)' }}>
                    {systemStatus.scheduler?.running ? 'RUNNING' : 'STOPPED'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 12, fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div>Polling Interval: <strong>{systemStatus.scheduler?.intervalMs ? `${systemStatus.scheduler.intervalMs / 1000}s` : '60s'}</strong></div>
                  <div>Active Jobs: <strong>{systemStatus.scheduler?.scheduledWorkflows?.length || 0}</strong></div>
                </div>
              </div>

              {/* Database Metrics */}
              <div className="card" style={{ padding: 20 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Database & Scaling</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 24, fontWeight: 900 }}>
                    {systemStatus.database?.database_size || 'N/A'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 12, fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div>Active Connections: <strong>{systemStatus.database?.active_connections || 0}</strong></div>
                  <div>Security: <strong>Postgres RLS Enabled</strong></div>
                </div>
              </div>
            </div>
          )}

          {/* Tenants Administration */}
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 16 }}>🏢 Tenant Management ({tenants.length})</h2>
            <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-white-secondary)' }}>
                    <th style={{ padding: '12px 20px', fontWeight: 700, color: 'var(--text-muted)' }}>Organisation / Slug</th>
                    <th style={{ padding: '12px 20px', fontWeight: 700, color: 'var(--text-muted)' }}>Billing Plan</th>
                    <th style={{ padding: '12px 20px', fontWeight: 700, color: 'var(--text-muted)' }}>Status</th>
                    <th style={{ padding: '12px 20px', fontWeight: 700, color: 'var(--text-muted)' }}>Resources</th>
                    <th style={{ padding: '12px 20px', fontWeight: 700, color: 'var(--text-muted)' }}>Created At</th>
                    <th style={{ padding: '12px 20px', fontWeight: 700, color: 'var(--text-muted)', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map(t => (
                    <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '16px 20px' }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{t.name}</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>{t.slug}</div>
                      </td>
                      <td style={{ padding: '16px 20px' }}>
                        <select
                          className="input"
                          style={{ padding: '4px 8px', fontSize: 12, height: 'auto', width: 'auto' }}
                          value={t.plan}
                          disabled={updatingId === t.id}
                          onChange={e => updateTenant(t.id, { plan: e.target.value })}
                        >
                          <option value="TRIAL">TRIAL</option>
                          <option value="GROWTH">GROWTH</option>
                          <option value="ENTERPRISE">ENTERPRISE</option>
                        </select>
                      </td>
                      <td style={{ padding: '16px 20px' }}>
                        <select
                          className="input"
                          style={{
                            padding: '4px 8px', fontSize: 12, height: 'auto', width: 'auto',
                            color: t.status === 'ACTIVE' ? 'var(--green)' : 'var(--text-danger)',
                            fontWeight: 700
                          }}
                          value={t.status}
                          disabled={updatingId === t.id}
                          onChange={e => updateTenant(t.id, { status: e.target.value })}
                        >
                          <option value="ACTIVE" style={{ color: 'var(--green)' }}>ACTIVE</option>
                          <option value="SUSPENDED" style={{ color: 'var(--text-danger)' }}>SUSPENDED</option>
                        </select>
                      </td>
                      <td style={{ padding: '16px 20px', color: 'var(--text-muted)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', width: 140 }}>
                          <span>Users: <strong>{t.user_count}</strong></span>
                          <span>Agents: <strong>{t.agent_count}</strong></span>
                          <span>Flows: <strong>{t.workflow_count}</strong></span>
                          <span>Tasks: <strong>{t.task_count}</strong></span>
                        </div>
                      </td>
                      <td style={{ padding: '16px 20px', color: 'var(--text-muted)' }}>
                        {new Date(t.created_at).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '16px 20px', textAlign: 'right' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={updatingId === t.id}
                          onClick={() => {
                            localStorage.setItem('kuvalam_tenant_id', t.id)
                            // Reload to apply correct tenant context
                            window.location.href = '/dashboard'
                          }}
                        >
                          👁 Impersonate
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
