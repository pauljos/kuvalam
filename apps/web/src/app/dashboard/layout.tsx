'use client'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import {
  LayoutGrid, Bot, Workflow, CheckCircle2, Library, Plug, BarChart3,
  ScrollText, Settings, Shield, Zap, Search, Menu, X, LogOut, Building2
} from 'lucide-react'
import { AppProvider, useApp } from '@/lib/context'
import { CommandPalette } from '@/components/CommandPalette'

type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>
  match?: (path: string) => boolean
}

type NavGroup = { label?: string; items: NavItem[] }

const primaryNav: NavItem[] = [
  { href: '/dashboard',            label: 'Overview',      icon: LayoutGrid },
  { href: '/dashboard/agents',     label: 'Agents',        icon: Bot },
  { href: '/dashboard/workflows',  label: 'Workflows',     icon: Workflow },
  { href: '/dashboard/triggers',   label: 'Triggers',      icon: Zap },
  { href: '/dashboard/approvals',  label: 'Approvals',     icon: CheckCircle2 },
  { href: '/dashboard/knowledge',  label: 'Knowledge',     icon: Library },
  {
    href: '/dashboard/connectors',
    label: 'Integrations',
    icon: Plug,
    // Also mark active when user is on the tools page (same section)
    match: (p) => p.startsWith('/dashboard/connectors') || p.startsWith('/dashboard/tools'),
  },
]

const insightsNav: NavItem[] = [
  { href: '/dashboard/analytics',  label: 'Analytics',     icon: BarChart3 },
  { href: '/dashboard/audit',      label: 'Audit Log',     icon: ScrollText },
]

const bottomNav: NavItem[] = [
  { href: '/dashboard/settings',   label: 'Settings',      icon: Settings },
]

function useNavGroups(isSystemAdmin: boolean): NavGroup[] {
  const groups: NavGroup[] = [
    { items: primaryNav },
    { label: 'Insights', items: insightsNav },
  ]
  const bottom = [...bottomNav]
  if (isSystemAdmin) {
    bottom.push({ href: '/dashboard/admin', label: 'System Portal', icon: Shield })
  }
  groups.push({ label: 'Account', items: bottom })
  return groups
}

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname()
  const { user, logout } = useApp()
  const groups = useNavGroups(!!user?.isSystemAdmin)

  const isActive = (item: NavItem) => {
    if (item.match) return item.match(pathname)
    if (item.href === '/dashboard') return pathname === item.href
    return pathname.startsWith(item.href)
  }

  return (
    <>
      {/* Brand */}
      <div style={{ padding: '18px 20px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link href="/dashboard" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }} onClick={onClose}>
          <div style={{
            width: 32, height: 32, borderRadius: 9, flexShrink: 0,
            background: 'linear-gradient(135deg, var(--green) 0%, var(--yellow-light) 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', boxShadow: '0 2px 8px rgba(63,138,67,0.25)'
          }}>
            <Zap size={17} strokeWidth={2.5} />
          </div>
          <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: '-0.4px', color: 'var(--text)' }}>Kuvalam</span>
        </Link>
        {onClose && (
          <button onClick={onClose} className="header-icon-btn" aria-label="Close menu" style={{ width: 32, height: 32 }}>
            <X size={16} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '4px 0 12px', overflowY: 'auto' }}>
        {groups.map((group, gi) => (
          <div key={gi} style={{ marginBottom: 6 }}>
            {group.label && <div className="sidebar-group-label">{group.label}</div>}
            {group.items.map(item => {
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sidebar-item ${isActive(item) ? 'active' : ''}`}
                  onClick={onClose}
                >
                  <Icon size={17} strokeWidth={2} />
                  <span>{item.label}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* User footer */}
      {user && (
        <div style={{ padding: '12px 14px 16px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px' }}>
            <div style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: 'var(--yellow)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 12, fontWeight: 900, color: 'var(--text)'
            }}>{user.name?.[0]?.toUpperCase() || 'U'}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
            </div>
            <button
              onClick={logout}
              className="header-icon-btn"
              aria-label="Sign out"
              title="Sign out"
              style={{ width: 32, height: 32 }}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function pageTitleFromPath(pathname: string): string {
  if (pathname === '/dashboard') return 'Overview'
  const seg = pathname.replace(/^\/dashboard\/?/, '').split('/')[0]
  const map: Record<string, string> = {
    agents: 'Agents',
    workflows: 'Workflows',
    triggers: 'Triggers',
    approvals: 'Approvals',
    knowledge: 'Knowledge',
    connectors: 'Integrations',
    tools: 'Integrations',
    analytics: 'Analytics',
    audit: 'Audit Log',
    settings: 'Settings',
    profile: 'My Profile',
    admin: 'System Portal',
  }
  return map[seg] || seg.charAt(0).toUpperCase() + seg.slice(1)
}

function AppHeader({ onMenuClick }: { onMenuClick: () => void }) {
  const pathname = usePathname()
  const { tenant, tenants, setTenant } = useApp()
  const title = pageTitleFromPath(pathname)

  function openPalette() {
    window.dispatchEvent(new CustomEvent('kuvalam:open-palette'))
  }

  return (
    <div className="app-header">
      {/* Mobile menu */}
      <button onClick={onMenuClick} className="header-icon-btn mobile-only" aria-label="Open menu">
        <Menu size={18} />
      </button>

      <div className="app-header-title header-title-desktop">{title}</div>

      <button className="app-header-search" onClick={openPalette} aria-label="Open command palette">
        <Search size={15} />
        <span>Search agents, workflows, docs…</span>
        <span className="app-header-search-hint">⌘K</span>
      </button>

      <div className="app-header-right">
        {tenant && tenants.length > 1 ? (
          <div className="header-tenant" title="Switch organisation">
            <Building2 size={14} />
            <select
              value={tenant.id}
              onChange={e => { const next = tenants.find(t => t.id === e.target.value); if (next) setTenant(next) }}
            >
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        ) : tenant ? (
          <div className="header-tenant" title={tenant.name}>
            <Building2 size={14} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{tenant.name}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const pathname = usePathname()

  // Close mobile drawer on route change
  useEffect(() => { setMobileOpen(false) }, [pathname])

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* Desktop sidebar */}
      <aside className="sidebar" style={{ display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh', overflowY: 'auto' }}>
        <SidebarContent />
      </aside>

      {/* Mobile sidebar + backdrop */}
      {mobileOpen && (
        <>
          <div className="sidebar-mobile-backdrop open" onClick={() => setMobileOpen(false)} />
          <aside className="sidebar sidebar-open" style={{ display: 'flex', flexDirection: 'column' }}>
            <SidebarContent onClose={() => setMobileOpen(false)} />
          </aside>
        </>
      )}

      {/* Main */}
      <main id="main-content" style={{ flex: 1, minHeight: '100vh', overflow: 'auto', minWidth: 0 }}>
        <AppHeader onMenuClick={() => setMobileOpen(true)} />
        {children}
      </main>
      <CommandPalette />
    </div>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <DashboardShell>{children}</DashboardShell>
    </AppProvider>
  )
}
