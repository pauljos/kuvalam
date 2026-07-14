'use client'
import { useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setMsg(null)
    try {
      await api.forgotPassword({ email })
      setMsg({ type: 'success', text: 'If that email is registered, we sent a reset link. Check your inbox and spam folder.' })
    } catch (err: any) {
      // Even on error, show generic message for security (do not reveal enumeration)
      setMsg({ type: 'success', text: 'If that email is registered, we sent a reset link. Check your inbox and spam folder.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #f0f4ea 0%, #d8e5cc 100%)', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 420, background: 'var(--bg-white)', padding: 40, borderRadius: 16, boxShadow: '0 20px 40px rgba(0,0,0,0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--green)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 900 }}>⚡</div>
          <span style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.5px' }}>Kuvalam</span>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Reset your password</h1>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 24 }}>
          Enter your email and we&apos;ll send you a link to reset your password.
        </p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus />
          </div>
          {msg && (
            <div className={`alert alert-${msg.type}`}>{msg.type === 'success' ? '✓ ' : '⚠ '}{msg.text}</div>
          )}
          <button className="btn btn-primary btn-lg" type="submit" disabled={loading}>
            {loading ? '⟳ Sending…' : 'Send reset link'}
          </button>
        </form>
        <p style={{ textAlign: 'center', marginTop: 20, fontSize: 13 }}>
          <Link href="/" style={{ color: 'var(--green)', fontWeight: 700, textDecoration: 'none' }}>← Back to sign in</Link>
        </p>
      </div>
    </div>
  )
}
