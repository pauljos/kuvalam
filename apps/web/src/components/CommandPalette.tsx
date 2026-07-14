'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

interface Command {
  id: string
  label: string
  hint?: string
  icon: string
  section: string
  action: () => void
}

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Register global Cmd-K / Ctrl-K + external open event
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    function onExternalOpen() { setOpen(true) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('kuvalam:open-palette', onExternalOpen as EventListener)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('kuvalam:open-palette', onExternalOpen as EventListener)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  const go = useCallback((href: string) => {
    setOpen(false)
    router.push(href)
  }, [router])

  const commands: Command[] = [
    { id: 'go-overview',    section: 'Navigate', icon: '◈',  label: 'Go to Overview',    action: () => go('/dashboard') },
    { id: 'go-agents',      section: 'Navigate', icon: '⚡', label: 'Go to Agents',      action: () => go('/dashboard/agents') },
    { id: 'go-workflows',   section: 'Navigate', icon: '⟳',  label: 'Go to Workflows',   action: () => go('/dashboard/workflows') },
    { id: 'go-triggers',    section: 'Navigate', icon: '⚡', label: 'Go to Triggers',    action: () => go('/dashboard/triggers') },
    { id: 'go-knowledge',   section: 'Navigate', icon: '📚', label: 'Go to Knowledge',   action: () => go('/dashboard/knowledge') },
    { id: 'go-approvals',   section: 'Navigate', icon: '✅', label: 'Go to Approvals',   action: () => go('/dashboard/approvals') },
    { id: 'go-integrations',section: 'Navigate', icon: '🔌', label: 'Go to Integrations', hint: 'Connectors, tools & MCP', action: () => go('/dashboard/connectors') },
    { id: 'go-connectors',  section: 'Navigate', icon: '🔌', label: 'Go to Connectors',  action: () => go('/dashboard/connectors') },
    { id: 'go-tools',       section: 'Navigate', icon: '🛠', label: 'Go to Tools & MCP', action: () => go('/dashboard/tools') },
    { id: 'go-analytics',   section: 'Navigate', icon: '📊', label: 'Go to Analytics',   action: () => go('/dashboard/analytics') },
    { id: 'go-audit',       section: 'Navigate', icon: '📋', label: 'Go to Audit Log',   action: () => go('/dashboard/audit') },
    { id: 'go-settings',    section: 'Navigate', icon: '⚙',  label: 'Go to Settings',    action: () => go('/dashboard/settings') },
    { id: 'go-profile',     section: 'Navigate', icon: '👤', label: 'Go to My Profile',  action: () => go('/dashboard/profile') },
    { id: 'new-agent',      section: 'Create',   icon: '+',  label: 'New agent',         hint: 'Create an AI agent', action: () => go('/dashboard/agents?new=1') },
    { id: 'new-workflow',   section: 'Create',   icon: '+',  label: 'New workflow',      hint: 'Multi-step automation', action: () => go('/dashboard/workflows?new=1') },
    { id: 'new-trigger',    section: 'Create',   icon: '+',  label: 'New trigger',       hint: 'Webhook, schedule, event', action: () => go('/dashboard/triggers?new=1') },
    { id: 'new-kb',         section: 'Create',   icon: '+',  label: 'New knowledge base', action: () => go('/dashboard/knowledge?new=1') },
    { id: 'invite-member',  section: 'Team',     icon: '👥', label: 'Invite team member',  action: () => go('/dashboard/settings?tab=members') },
  ]

  const filtered = query
    ? commands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()) || c.section.toLowerCase().includes(query.toLowerCase()))
    : commands

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[activeIdx]
      if (cmd) cmd.action()
    }
  }

  if (!open) return null

  // Group by section preserving order
  const groups: Record<string, Command[]> = {}
  filtered.forEach(c => { (groups[c.section] ||= []).push(c) })

  let idx = 0
  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '10vh', zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(600px, 92vw)', background: '#fff', borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,0.24), 0 4px 16px rgba(0,0,0,0.12)',
          overflow: 'hidden', border: '1px solid #e5e7eb',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16, color: '#9ca3af' }}>⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0) }}
            onKeyDown={handleKey}
            placeholder="Search or type a command..."
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 15, color: '#1a1a1a', background: 'transparent' }}
          />
          <span style={{ fontSize: 11, color: '#9ca3af', border: '1px solid #e5e7eb', padding: '2px 6px', borderRadius: 4 }}>ESC</span>
        </div>
        <div style={{ maxHeight: '50vh', overflowY: 'auto', padding: '6px 0' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No matches for &quot;{query}&quot;
            </div>
          )}
          {Object.entries(groups).map(([section, cmds]) => (
            <div key={section}>
              <div style={{ padding: '10px 18px 4px', fontSize: 10, fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.6 }}>{section}</div>
              {cmds.map(c => {
                const myIdx = idx++
                const active = myIdx === activeIdx
                return (
                  <div
                    key={c.id}
                    onMouseEnter={() => setActiveIdx(myIdx)}
                    onClick={c.action}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '10px 18px', cursor: 'pointer',
                      background: active ? '#f7f5ea' : 'transparent',
                      borderLeft: `3px solid ${active ? 'var(--yellow, #d6c304)' : 'transparent'}`,
                    }}
                  >
                    <span style={{ fontSize: 15, width: 20, textAlign: 'center' }}>{c.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a' }}>{c.label}</div>
                      {c.hint && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{c.hint}</div>}
                    </div>
                    {active && <span style={{ fontSize: 11, color: '#9ca3af' }}>↵</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div style={{ padding: '8px 18px', borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9ca3af' }}>
          <div>↑↓ navigate · ↵ select</div>
          <div>Press <b>⌘K</b> anywhere to open</div>
        </div>
      </div>
    </div>
  )
}
