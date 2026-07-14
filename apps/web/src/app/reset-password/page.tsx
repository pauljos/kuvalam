'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'

function ResetPasswordForm() {
  const router = useRouter()
  const params = useSearchParams()
  const token = params.get('token') || ''
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!token) setMsg({ type: 'error', text: 'Missing reset token. Please request a new reset link.' })
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (newPassword.length < 8) {
      setMsg({ type: 'error', text: 'Password must be at least 8 characters.' })
      return
    }
    if (newPassword !== confirm) {
      setMsg({ type: 'error', text: 'Passwords do not match.' })
      return
    }
    setLoading(true); setMsg(null)
    try {
      await api.resetPassword({ token, newPassword })
      setMsg({ type: 'success', text: 'Password reset! Redirecting to sign in…' })
      setTimeout(() => router.push('/'), 1800)
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || 'Reset failed. The link may be expired.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Set a new password</h1>
      <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 24 }}>
        Choose a strong password with at least 8 characters.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="form-group">
          <label className="form-label">New password</label>
          <input className="input" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={8} autoComplete="new-password" autoFocus disabled={!token} />
        </div>
        <div className="form-group">
          <label className="form-label">Confirm password</label>
          <input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" disabled={!token} />
        </div>
        {msg && (
          <div className={`alert alert-${msg.type}`}>{msg.type === 'success' ? '✓ ' : '⚠ '}{msg.text}</div>
        )}
        <button className="btn btn-primary btn-lg" type="submit" disabled={loading || !token}>
          {loading ? '⟳ Resetting…' : 'Reset password'}
        </button>
      </form>
      <p style={{ textAlign: 'center', marginTop: 20, fontSize: 13 }}>
        <Link href="/" style={{ color: 'var(--green)', fontWeight: 700, textDecoration: 'none' }}>← Back to sign in</Link>
      </p>
    </>
  )
}

export default function ResetPasswordPage() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #f0f4ea 0%, #d8e5cc 100%)', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 420, background: 'var(--bg-white)', padding: 40, borderRadius: 16, boxShadow: '0 20px 40px rgba(0,0,0,0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--green)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 900 }}>⚡</div>
          <span style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.5px' }}>Kuvalam</span>
        </div>
        <Suspense fallback={<div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  )
}
