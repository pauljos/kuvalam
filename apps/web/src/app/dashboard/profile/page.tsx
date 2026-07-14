'use client'
import { useEffect, useState } from 'react'
import { useApp } from '@/lib/context'
import { api } from '@/lib/api'

export default function ProfilePage() {
  const { toast, user } = useApp()
  const [profile, setProfile] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

  useEffect(() => {
    api.getProfile()
      .then(p => { setProfile(p); setName(p.name || '') })
      .catch(err => toast('error', 'Failed to load profile', err.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function saveName(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSavingName(true)
    try {
      const updated = await api.updateProfile({ name: name.trim() })
      setProfile(updated)
      toast('success', 'Profile updated', 'Your display name has been saved.')
    } catch (err: any) {
      toast('error', 'Update failed', err.message)
    } finally {
      setSavingName(false)
    }
  }

  async function changePwd(e: React.FormEvent) {
    e.preventDefault()
    if (newPassword.length < 8) {
      toast('error', 'Password too short', 'Use at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      toast('error', 'Passwords do not match', 'Please retype your new password.')
      return
    }
    setSavingPassword(true)
    try {
      await api.changePassword({ currentPassword, newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast('success', 'Password changed', 'Log in again on other devices.')
    } catch (err: any) {
      toast('error', 'Change failed', err.message)
    } finally {
      setSavingPassword(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">My Profile</h1>
          <p className="page-sub">Manage your personal account settings and password</p>
        </div>
      </div>

      <div className="page-body" style={{ maxWidth: 720 }}>
        {loading ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
        ) : (
          <>
            {/* Identity card */}
            <div className="card" style={{ padding: 28, marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 24 }}>
                <div style={{
                  width: 72, height: 72, borderRadius: '50%',
                  background: 'linear-gradient(135deg, var(--yellow, #d6c304) 0%, #f5e050 100%)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 30, fontWeight: 900, color: '#1a1a1a',
                }}>
                  {(profile?.name || profile?.email || '?').charAt(0).toUpperCase()}
                </div>
                <div>
                  <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>{profile?.name || 'No name set'}</h2>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{profile?.email}</div>
                  {profile?.created_at && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      Member since {new Date(profile.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                    </div>
                  )}
                </div>
              </div>
              <form onSubmit={saveName}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Display name</label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="input"
                    placeholder="Your full name"
                    style={{ flex: 1 }}
                  />
                  <button type="submit" disabled={savingName || name === profile?.name} className="btn btn-primary">
                    {savingName ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            </div>

            {/* Password change */}
            <div className="card" style={{ padding: 28 }}>
              <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>Change password</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
                Choose a strong password with at least 8 characters. Changing your password will sign you out of all other devices.
              </p>
              <form onSubmit={changePwd} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Current password</label>
                  <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} className="input" required autoComplete="current-password" />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>New password</label>
                  <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="input" required minLength={8} autoComplete="new-password" />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Confirm new password</label>
                  <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="input" required minLength={8} autoComplete="new-password" />
                </div>
                <div>
                  <button type="submit" disabled={savingPassword || !currentPassword || !newPassword} className="btn btn-primary">
                    {savingPassword ? 'Changing…' : 'Change password'}
                  </button>
                </div>
              </form>
            </div>
          </>
        )}
      </div>
    </>
  )
}
