'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'

export default function OnboardingPage() {
  const router = useRouter()
  const [form, setForm] = useState({ name: '', slug: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string) => (e: any) => {
    const v = e.target.value
    setForm(f => ({
      ...f, [k]: v,
      ...(k === 'name' ? { slug: v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') } : {})
    }))
  }

  async function submit(e: any) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const tenant = await api.createTenant(form)
      localStorage.setItem('kuvalam_tenant_id', tenant.id)
      const tenants = JSON.parse(localStorage.getItem('kuvalam_tenants') || '[]')
      tenants.push({ id: tenant.id, name: tenant.name, slug: tenant.slug, role: 'OWNER' })
      localStorage.setItem('kuvalam_tenants', JSON.stringify(tenants))
      router.push('/dashboard')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24
    }}>
      <div style={{ width: '100%', maxWidth: 460 }} className="animate-in">
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 16,
            background: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px', fontSize: 24, color: 'white',
            boxShadow: '0 4px 12px rgba(112,136,14,0.3)'
          }}>🏢</div>
          <h1 className="page-title" style={{ fontSize: 24 }}>Create your Organisation</h1>
          <p className="page-sub" style={{ marginTop: 8 }}>
            Set up your workspace to start building with AI agents
          </p>
        </div>
        <div className="card" style={{ padding: 32 }}>
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="form-group">
              <label className="form-label">Organisation Name</label>
              <input className="input input-lg" placeholder="Acme Corp" value={form.name} onChange={set('name')} required />
            </div>
            <div className="form-group">
              <label className="form-label">Workspace URL</label>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <span style={{
                  padding: '12px 14px', background: 'var(--bg)', border: '1.5px solid var(--border)',
                  borderRight: 'none', borderRadius: 'var(--radius) 0 0 var(--radius)', fontSize: 14, color: 'var(--text-muted)'
                }}>kuvalam.ai/</span>
                <input className="input input-lg" style={{ borderRadius: '0 var(--radius) var(--radius) 0' }} placeholder="acme-corp" value={form.slug} onChange={set('slug')} required pattern="[a-z0-9-]+" />
              </div>
              <p className="form-hint" style={{ marginTop: 4 }}>Lowercase letters, numbers, hyphens only</p>
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <button className="btn btn-primary btn-lg" type="submit" disabled={loading}>
              {loading ? 'Creating...' : 'Create Organisation'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
