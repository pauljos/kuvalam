// src/lib/context.tsx
// Global app context — user, tenant, toast notifications
// Wraps the whole dashboard so every page can call useApp() instead of reading localStorage directly

'use client'
import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react'
import { useRouter } from 'next/navigation'

// ─── Types ────────────────────────────────────────────────────────────────────
export interface User {
  id: string
  email: string
  name: string
  isSystemAdmin?: boolean
}

export interface Tenant {
  id: string
  name: string
  plan?: string
  slug?: string
}

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: string
  type: ToastType
  title: string
  message?: string
}

interface AppContextValue {
  user: User | null
  tenant: Tenant | null
  tenants: Tenant[]
  tenantId: string
  setTenant: (t: Tenant) => void
  toast: (type: ToastType, title: string, message?: string) => void
  toasts: Toast[]
  dismissToast: (id: string) => void
  logout: () => void
}

// ─── Context ──────────────────────────────────────────────────────────────────
const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [tenant, setTenantState] = useState<Tenant | null>(null)
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastCounter = useRef(0)

  useEffect(() => {
    try {
      const u = localStorage.getItem('kuvalam_user')
      const t = localStorage.getItem('kuvalam_tenant_id')
      const ts = localStorage.getItem('kuvalam_tenants')
      if (u) setUser(JSON.parse(u))
      if (ts) {
        const parsed: Tenant[] = JSON.parse(ts)
        setTenants(parsed)
        if (t) {
          const active = parsed.find(x => x.id === t) || parsed[0] || null
          setTenantState(active)
        }
      }
    } catch { /* ignore corrupt localStorage */ }
  }, [])

  const setTenant = useCallback((t: Tenant) => {
    setTenantState(t)
    localStorage.setItem('kuvalam_tenant_id', t.id)
  }, [])

  const toast = useCallback((type: ToastType, title: string, message?: string) => {
    const id = `toast-${++toastCounter.current}`
    setToasts(prev => [...prev, { id, type, title, message }])
    // Auto-dismiss after 4 seconds
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  function logout() {
    localStorage.clear()
    router.push('/')
  }

  return (
    <AppContext.Provider value={{
      user, tenant, tenants,
      tenantId: tenant?.id || '',
      setTenant, toast, toasts, dismissToast, logout
    }}>
      {children}
      <ToastStack toasts={toasts} dismiss={dismissToast} />
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

// ─── Toast Stack UI ───────────────────────────────────────────────────────────
const TOAST_ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
}

const TOAST_COLORS: Record<ToastType, { bg: string; border: string; icon: string }> = {
  success: { bg: '#f0fdf4', border: '#86efac', icon: '#16a34a' },
  error:   { bg: '#fef2f2', border: '#fca5a5', icon: '#dc2626' },
  warning: { bg: '#fffbeb', border: '#fcd34d', icon: '#d97706' },
  info:    { bg: '#eff6ff', border: '#93c5fd', icon: '#2563eb' },
}

function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  if (!toasts.length) return null
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 380,
      pointerEvents: 'none',
    }}>
      {toasts.map(t => {
        const c = TOAST_COLORS[t.type]
        return (
          <div key={t.id} style={{
            background: c.bg, border: `1px solid ${c.border}`,
            borderRadius: 12, padding: '12px 16px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            display: 'flex', alignItems: 'flex-start', gap: 12,
            animation: 'toast-in 0.25s cubic-bezier(0.16,1,0.3,1)',
            pointerEvents: 'all',
          }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: c.icon, marginTop: 1, flexShrink: 0,
              width: 20, height: 20, borderRadius: '50%', background: `${c.icon}18`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{TOAST_ICONS[t.type]}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#1a1a1a', lineHeight: 1.3 }}>{t.title}</div>
              {t.message && <div style={{ fontSize: 12, color: '#666', marginTop: 2, lineHeight: 1.4 }}>{t.message}</div>}
            </div>
            <button onClick={() => dismiss(t.id)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#999', fontSize: 14, padding: 0, marginTop: -2, flexShrink: 0,
              lineHeight: 1
            }}>✕</button>
          </div>
        )
      })}
    </div>
  )
}
