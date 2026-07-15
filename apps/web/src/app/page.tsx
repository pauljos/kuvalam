'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import {
  Sparkles, Workflow, BookOpenText, ShieldCheck, PlugZap,
  ArrowRight, Loader2, AlertTriangle, CheckCircle2,
} from 'lucide-react'

// ── Landing / auth page ────────────────────────────────────────────────────
// Palette matches the in-app brand tokens from globals.css:
//   --green         #3f8a43   (primary brand — buttons, sidebar active)
//   --green-dark    #256329   (headings, hover state)
//   --green-light   #68b36c
//   --green-bg      #edf7ee   (soft surface tint)
//   --green-border  #d2ecd5
// The hero is intentionally mostly-white with brand-green accents so the
// landing page reads as the same product as the dashboard chrome.
const BRAND = {
  green: '#3f8a43',
  greenDark: '#256329',
  greenLight: '#68b36c',
  greenBg: '#edf7ee',
  greenBorder: '#d2ecd5',
  text: '#1d3524',
  textMuted: '#5b7563',
  surface: '#ffffff',
  surfaceSoft: '#f5f9f6',
}

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [form, setForm] = useState({ 
    email: '', 
    password: '', 
    name: '', 
    tenantSlug: '',
    tenantName: '',
    orgSlug: '' 
  })
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null)
  const set = (k: string) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit(e: any) {
    e.preventDefault(); setLoading(true); setMsg(null)
    try {
      if (mode === 'register') {
        const result = await api.register({
          email: form.email,
          password: form.password,
          name: form.name,
          tenantName: form.tenantName,
          tenantSlug: form.orgSlug
        })
        setMsg({ 
          type: 'success', 
          text: result.approvalStatus === 'PENDING' 
            ? 'Registration successful! Your organization is pending approval. You\'ll receive an email once approved.'
            : 'Account created! Sign in below.' 
        })
        setMode('login')
      } else {
        const data = await api.login({ 
          email: form.email, 
          password: form.password,
          tenantSlug: form.tenantSlug 
        })
        // accessToken is now set as an httpOnly cookie by the API — do NOT store in localStorage
        localStorage.setItem('kuvalam_user', JSON.stringify(data.user))
        if (data.tenant) {
          localStorage.setItem('kuvalam_tenant', JSON.stringify(data.tenant))
          localStorage.setItem('kuvalam_tenant_id', data.tenant.id)
          router.push('/dashboard')
        } else if (data.user?.isSystemAdmin) {
          router.push('/dashboard')
        } else {
          router.push('/onboarding')
        }
      }
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message })
    } finally { setLoading(false) }
  }

  const features = [
    { icon: Workflow,     text: 'Multi-tenant, multi-agent orchestration' },
    { icon: BookOpenText, text: 'Knowledge-augmented reasoning' },
    { icon: ShieldCheck,  text: 'Human-in-the-loop oversight' },
    { icon: PlugZap,      text: 'Connect any tool, API, or database' },
  ]

  return (
    <div
      className="kv-landing"
      style={{ minHeight: '100vh', display: 'flex', background: BRAND.surface }}
    >
      {/* Left — hero (soft leaf-green wash, not a solid dark panel) */}
      <div
        style={{
          flex: 1.15,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '56px 64px',
          background:
            'radial-gradient(1100px 600px at 12% -10%, rgba(104,179,108,0.18), transparent 60%),' +
            'radial-gradient(800px 500px at 110% 110%, rgba(63,138,67,0.10), transparent 55%),' +
            'linear-gradient(160deg, #f8fbf5 0%, #edf7ee 55%, #d2ecd5 100%)',
          color: BRAND.text,
          overflow: 'hidden',
          borderRight: '1px solid ' + BRAND.greenBorder,
        }}
      >
        {/* Subtle dot grid */}
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0,
            backgroundImage: 'radial-gradient(rgba(37,99,41,0.08) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
            maskImage: 'radial-gradient(ellipse at 30% 40%, black 30%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse at 30% 40%, black 30%, transparent 75%)',
            pointerEvents: 'none',
          }}
        />

        {/* Top: brand */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'linear-gradient(135deg, ' + BRAND.green + ' 0%, ' + BRAND.greenDark + ' 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 8px 22px -6px rgba(37,99,41,0.35), inset 0 0 0 1px rgba(255,255,255,0.15)',
            }}
          >
            <Sparkles size={20} color="#ffffff" strokeWidth={2.4} />
          </div>
          <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px', color: BRAND.greenDark }}>
            Kuvalam
          </span>
        </div>

        {/* Middle: headline + features */}
        <div style={{ position: 'relative', maxWidth: 520 }}>
          <div
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 12px', borderRadius: 999,
              background: BRAND.surface,
              border: '1px solid ' + BRAND.greenBorder,
              color: BRAND.greenDark, fontSize: 12, fontWeight: 600,
              marginBottom: 22,
              boxShadow: '0 2px 8px rgba(37,99,41,0.05)',
            }}
          >
            <span
              style={{
                width: 6, height: 6, borderRadius: 999,
                background: BRAND.green,
                boxShadow: '0 0 10px ' + BRAND.greenLight,
              }}
            />
            AI Workforce · Live agents, running now
          </div>

          <h1
            style={{
              fontSize: 52, lineHeight: 1.05, fontWeight: 800,
              letterSpacing: '-1.5px', margin: '0 0 20px', color: BRAND.text,
            }}
          >
            Ship AI agents that{' '}
            <span style={{ color: BRAND.green }}>act</span>
            , not just chat.
          </h1>

          <p style={{ fontSize: 16, lineHeight: 1.65, color: BRAND.textMuted, maxWidth: 460, margin: '0 0 32px' }}>
            Deploy autonomous agents that research, plan, decide, and execute across
            your tools — with human approvals, memory, and full audit trails.
          </p>

          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {features.map(f => (
              <li key={f.text} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14.5 }}>
                <span
                  style={{
                    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                    background: BRAND.greenBg,
                    border: '1px solid ' + BRAND.greenBorder,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <f.icon size={15} color={BRAND.green} strokeWidth={2.2} />
                </span>
                <span style={{ color: BRAND.text }}>{f.text}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Bottom: footer strip */}
        <div
          style={{
            position: 'relative', display: 'flex', alignItems: 'center', gap: 16,
            fontSize: 12, color: BRAND.textMuted,
            paddingTop: 20, borderTop: '1px solid ' + BRAND.greenBorder,
          }}
        >
          <span>SOC-ready by design</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>Multi-tenant, isolated by row-level security</span>
        </div>
      </div>

      {/* Right — form panel */}
      <div
        style={{
          width: 460,
          minWidth: 380,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '48px 44px', background: BRAND.surface,
        }}
      >
        <div style={{ width: '100%', maxWidth: 360 }} className="animate-in">
          <h2 style={{ fontSize: 26, fontWeight: 800, marginBottom: 6, color: BRAND.text, letterSpacing: '-0.5px' }}>
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </h2>
          <p style={{ color: BRAND.textMuted, marginBottom: 30, fontSize: 14 }}>
            {mode === 'login' ? "New to Kuvalam? " : 'Already have an account? '}
            <button
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setMsg(null); setForm({ email: '', password: '', name: '', tenantSlug: '', tenantName: '', orgSlug: '' }) }}
              style={{
                background: 'none', border: 'none', color: BRAND.green,
                fontWeight: 700, cursor: 'pointer', fontSize: 14, fontFamily: 'inherit',
                padding: 0, display: 'inline-flex', alignItems: 'center', gap: 3,
              }}
            >
              {mode === 'login' ? 'Create an account' : 'Sign in'}
              <ArrowRight size={13} strokeWidth={2.5} />
            </button>
          </p>

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {mode === 'register' && (
              <>
                <div className="form-group">
                  <label className="form-label">Full name</label>
                  <input className="input" placeholder="Paul Joseph" value={form.name} onChange={set('name')} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Organization name</label>
                  <input className="input" placeholder="Acme Inc" value={form.tenantName} onChange={set('tenantName')} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Organization slug</label>
                  <input 
                    className="input" 
                    placeholder="acme" 
                    value={form.orgSlug} 
                    onChange={set('orgSlug')} 
                    pattern="[a-z0-9-]+"
                    title="Lowercase letters, numbers, and hyphens only"
                    required 
                  />
                  <p style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 4 }}>
                    Used in your login URL (lowercase, no spaces)
                  </p>
                </div>
              </>
            )}
            <div className="form-group">
              <label className="form-label">Work email</label>
              <input className="input" type="email" placeholder="you@company.com" value={form.email} onChange={set('email')} required />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input className="input" type="password" placeholder="Min. 8 characters" value={form.password} onChange={set('password')} required minLength={8} />
              {mode === 'login' && (
                <div style={{ textAlign: 'right', marginTop: 6 }}>
                  <a href="/forgot-password" style={{ fontSize: 12, color: BRAND.green, fontWeight: 700, textDecoration: 'none' }}>
                    Forgot password?
                  </a>
                </div>
              )}
            </div>
            {mode === 'login' && (
              <div className="form-group">
                <label className="form-label">Organization slug (optional for system admins)</label>
                <input className="input" placeholder="acme" value={form.tenantSlug} onChange={set('tenantSlug')} />
                <p style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 4 }}>
                  Leave blank if you're a system administrator
                </p>
              </div>
            )}

            {msg && (
              <div
                role="alert"
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '10px 12px', borderRadius: 8, fontSize: 13,
                  background: msg.type === 'error' ? '#fef2f2' : BRAND.greenBg,
                  border: '1px solid ' + (msg.type === 'error' ? '#fecaca' : BRAND.greenBorder),
                  color: msg.type === 'error' ? '#991b1b' : BRAND.greenDark,
                }}
              >
                {msg.type === 'error'
                  ? <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                  : <CheckCircle2 size={14} style={{ marginTop: 1, flexShrink: 0 }} />}
                <span>{msg.text}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="kv-cta"
              style={{
                marginTop: 4, padding: '12px 18px',
                borderRadius: 10, border: 'none', cursor: loading ? 'wait' : 'pointer',
                fontSize: 15, fontWeight: 700, color: '#ffffff',
                background: loading
                  ? '#8fa896'
                  : 'linear-gradient(135deg, ' + BRAND.green + ' 0%, ' + BRAND.greenDark + ' 100%)',
                boxShadow: loading
                  ? 'none'
                  : '0 8px 20px -6px rgba(37,99,41,0.45), inset 0 0 0 1px rgba(255,255,255,0.12)',
                transition: 'transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              {loading
                ? <><Loader2 size={16} style={{ animation: 'kv-spin 1s linear infinite' }} /> Please wait…</>
                : <>{mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight size={15} /></>}
            </button>
          </form>

          <p style={{ textAlign: 'center', marginTop: 30, fontSize: 11, color: BRAND.textMuted, letterSpacing: 0.2 }}>
            Kuvalam v0.1 · AI Workforce Platform
          </p>
        </div>
      </div>

      {/* Scoped keyframes + spinner + hover polish (no global side-effects) */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes kv-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .kv-landing .kv-cta:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.04); }
        .kv-landing .kv-cta:active:not(:disabled) { transform: translateY(0); filter: brightness(0.98); }
        .kv-landing .input:focus { outline: none; border-color: ${BRAND.green}; box-shadow: 0 0 0 3px rgba(63,138,67,0.18); }
        @media (max-width: 900px) {
          .kv-landing { flex-direction: column; }
          .kv-landing > div:first-child { padding: 40px 28px !important; min-height: 340px; border-right: none !important; border-bottom: 1px solid ${BRAND.greenBorder} !important; }
          .kv-landing > div:last-child { width: 100% !important; padding: 36px 24px !important; }
        }
      ` }} />
    </div>
  )
}
