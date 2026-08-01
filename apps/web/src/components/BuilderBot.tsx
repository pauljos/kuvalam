'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import { Wand2, Bot, Workflow, Plug, Zap, Library, ArrowUp, Loader2, ExternalLink, Sparkles, X, Minimize2, Maximize2, MessageCircle, Paperclip } from 'lucide-react'
import Link from 'next/link'

// ── Types ────────────────────────────────────────────────────────────────────
interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  actions?: Array<{
    tool: string
    success: boolean
    result?: any
    error?: string
  }>
  suggestions?: string[]
  timestamp: string
}

interface BuilderContext {
  hasLlm: boolean
  defaultProvider: string | null
  providers: Array<{ name: string; model: string; isDefault: boolean }>
  counts: {
    agents: number
    workflows: number
    connectors: number
    knowledgeBases: number
    triggers: number
  }
}

const RESOURCE_ICONS: Record<string, React.ReactNode> = {
  agent: <Bot size={12} />,
  workflow: <Workflow size={12} />,
  connector: <Plug size={12} />,
  trigger: <Zap size={12} />,
  knowledge_base: <Library size={12} />,
}

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  // FAB (floating action button)
  fab: {
    position: 'fixed' as const,
    bottom: 24,
    right: 24,
    zIndex: 9999,
    width: 56,
    height: 56,
    borderRadius: 28,
    border: 'none',
    background: 'linear-gradient(135deg, var(--green) 0%, var(--yellow-light) 100%)',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 4px 24px rgba(63,138,67,0.35)',
    transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
  } as React.CSSProperties,

  // Panel (expanded chat window)
  panel: {
    position: 'fixed' as const,
    bottom: 24,
    right: 24,
    zIndex: 9999,
    width: 420,
    height: 600,
    maxHeight: 'calc(100vh - 100px)',
    borderRadius: 20,
    background: 'var(--bg-card, #ffffff)',
    border: '1px solid var(--border, #dfebd6)',
    boxShadow: '0 12px 60px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.04)',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    animation: 'builderSlideUp 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  } as React.CSSProperties,

  // Header bar
  header: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border, #dfebd6)',
    background: 'var(--bg-card, #ffffff)',
  },

  // Messages area
  messages: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },

  // Input area
  inputArea: {
    flexShrink: 0,
    padding: '12px 16px',
    borderTop: '1px solid var(--border, #dfebd6)',
    background: 'var(--bg-card, #ffffff)',
  },
}

// ── Component ────────────────────────────────────────────────────────────────
const CHAT_STORAGE_KEY = 'kuvalam_builder_messages'

export default function BuilderBot() {
  const { tenantId, toast, user } = useApp()
  const [open, setOpen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [messages, setMessages] = useState<Message[]>(() => {
    // Restore messages from localStorage on mount (keyed by tenant)
    try {
      const raw = localStorage.getItem(CHAT_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      }
    } catch { /* ignore corrupt data */ }
    return []
  })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [ctx, setCtx] = useState<BuilderContext | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [attachments, setAttachments] = useState<{name: string, type: string, contentBase64: string}[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Persist messages to localStorage whenever they change ───────────────
  useEffect(() => {
    try {
      // Only save non-empty conversations (don't overwrite with empty arrays on unmount)
      if (messages.length > 0) {
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages))
      }
    } catch { /* ignore quota errors */ }
  }, [messages])

  // ── Role ─────────────────────────────────────────────────────────────────
  const role = user?.role || 'VIEWER'
  const isSystemAdmin = user?.isSystemAdmin || false
  const canCreate = {
    agent: isSystemAdmin || role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER',
    workflow: isSystemAdmin || role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER',
    connector: isSystemAdmin || role === 'OWNER' || role === 'ADMIN',
    knowledgeBase: isSystemAdmin || role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER',
    trigger: isSystemAdmin || role === 'OWNER' || role === 'ADMIN',
  }
  const canCreateAnything = Object.values(canCreate).some(v => v)

  // ── Initialize on open ──────────────────────────────────────────────────
  useEffect(() => {
    if (open && !initialized && tenantId) {
      api.builderContext(tenantId).then((data: any) => {
        setCtx(data.success !== false ? data.data || data : data)
      }).catch(() => {})
      setInitialized(true)

      // Show welcome message
      if (messages.length === 0) {
        setMessages([{
          id: 'welcome',
          role: 'assistant',
          content: buildWelcomeMessage(),
          timestamp: new Date().toISOString(),
        }])
      }
    }
  }, [open, initialized, tenantId])

  // ── Auto-scroll ─────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // ── Focus on open ───────────────────────────────────────────────────────
  useEffect(() => {
    if (open && !minimized) {
      setTimeout(() => inputRef.current?.focus(), 300)
    }
  }, [open, minimized])

  // ── Press Escape to close ───────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open])

  // ── Listen for custom event from sidebar ─────────────────────────────────
  useEffect(() => {
    function handleOpenBuilder() {
      setOpen(true)
      setMinimized(false)
    }
    window.addEventListener('kuvalam:open-builder', handleOpenBuilder)
    return () => window.removeEventListener('kuvalam:open-builder', handleOpenBuilder)
  }, [])

  function buildWelcomeMessage(): string {
    if (!ctx) return ''
    const d = ctx
    if (!d.hasLlm) {
      return `## 👋 Hey! I'm the Kuvalam Builder Bot ⚡\n\n⚠️ **No LLM configured.** Please set up a provider in [Settings](/dashboard/settings) first.`
    }
    if (!canCreateAnything) {
      return `## 👋 Hey! I'm the Builder Bot 🔍\n\nYou have **read-only** access. I can search and list resources but can't create. Try:\n- "Show me our agents"\n- "What workflows exist?"`
    }
    const caps = []
    if (canCreate.agent) caps.push('agents')
    if (canCreate.workflow) caps.push('workflows')
    if (canCreate.connector) caps.push('connectors')
    if (canCreate.knowledgeBase) caps.push('knowledge bases')

    return `## 👋 Hey! I'm the Builder Bot ⚡\n\nI can create **${caps.join(', ')}** for your org.\n\n**Quick start:**\n- "Create a support agent"\n- "Build a Slack notification workflow"\n- "Set up a knowledge base for our docs"\n\nJust tell me what you need ↓`
  }

  // ── Send message ────────────────────────────────────────────────────────
  async function sendMessage(e?: React.FormEvent) {
    e?.preventDefault()
    if (!input.trim() || loading || !tenantId) return
    if (!ctx?.hasLlm) {
      toast('error', 'No LLM configured', 'Set up an LLM provider in Settings first.')
      return
    }

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const history = messages
        .filter(m => m.id !== 'welcome' && (m.role === 'user' || m.role === 'assistant'))
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }))

      const data = await api.builderChat(tenantId, { message: userMsg.content, history })

      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.message || '',
        actions: data.actions || [],
        suggestions: data.suggestions || [],
        timestamp: new Date().toISOString(),
      }])
    } catch (err: any) {
      const isTimeout = err.message?.toLowerCase().includes('timeout') || err.name === 'AbortError' || err.message?.toLowerCase().includes('fetch')
      const msg = isTimeout 
        ? "The request took too long (timeout). Please try again or check the server."
        : err.message
      
      toast('error', 'Builder error', msg)
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'system',
        content: `❌ ${msg}`,
        timestamp: new Date().toISOString(),
      }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }

  function handleQuickPrompt(text: string) {
    if (!canCreateAnything) return
    if (!ctx?.hasLlm) {
      toast('error', 'No LLM configured', 'Configure an LLM in Settings first.')
      return
    }
    setInput('')
    setLoading(true)

    const history = messages
      .filter(m => m.id !== 'welcome' && (m.role === 'user' || m.role === 'assistant'))
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }))

    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    }])

    api.builderChat(tenantId, { message: text, history, attachments })
      .then(data => {
        setMessages(prev => [...prev, {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.message || '',
          actions: data.actions || [],
          suggestions: data.suggestions || [],
          timestamp: new Date().toISOString(),
        }])
      })
      .catch(err => {
        const isTimeout = err.message?.toLowerCase().includes('timeout') || err.name === 'AbortError' || err.message?.toLowerCase().includes('fetch')
        const msg = isTimeout ? "The request took too long (timeout)." : err.message
        setMessages(prev => [...prev, {
          id: (Date.now() + 1).toString(),
          role: 'system',
          content: `❌ ${msg}`,
          timestamp: new Date().toISOString(),
        }])
      })
      .finally(() => {
        setLoading(false)
        setAttachments([])
        setTimeout(() => inputRef.current?.focus(), 100)
      })
  }

  // ── Render helpers ──────────────────────────────────────────────────────
  function renderContent(content: string) {
    if (!content) return null
    const parts = content.split(/(\*\*.*?\*\*|\[.*?\]\(.*?\))/g)
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i}>{part.slice(2, -2)}</strong>
      }
      if (part.startsWith('[') && part.includes('](')) {
        const m = part.match(/\[(.*?)\]\((.*?)\)/)
        if (m) {
          if (m[2].startsWith('/dashboard')) {
            return <Link key={i} href={m[2]} style={{ color: 'var(--green)', fontWeight: 600 }} onClick={() => setOpen(false)}>{m[1]}</Link>
          }
          return <a key={i} href={m[2]} target="_blank" rel="noopener" style={{ color: 'var(--green)' }}>{m[1]}</a>
        }
      }
      return <span key={i}>{part.split('\n').map((line, j, arr) => j < arr.length - 1 ? <span key={j}>{line}<br/></span> : line)}</span>
    })
  }

  function renderActions(actions: Message['actions']) {
    if (!actions?.length) return null
    return (
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {actions.map((a, i) => (
          <div key={i} style={{
            padding: '8px 12px', borderRadius: 10, fontSize: 12,
            background: a.success ? 'rgba(63,138,67,0.08)' : 'rgba(220,38,38,0.08)',
            border: `1px solid ${a.success ? 'rgba(63,138,67,0.2)' : 'rgba(220,38,38,0.2)'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ color: a.success ? 'var(--green)' : '#dc2626', fontWeight: 700 }}>{a.success ? '✓' : '✗'}</span>
              <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{a.tool?.replace(/_/g, ' ')}</span>
              {a.success && a.result?.resourceType && (
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 99, background: 'var(--bg)', opacity: 0.7 }}>
                  {a.result.resourceType.replace(/_/g, ' ')}
                </span>
              )}
            </div>
            {a.success && a.result?.url && (
              <Link href={a.result.url} style={{ fontSize: 11, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4, textDecoration: 'none', fontWeight: 600 }} onClick={() => setOpen(false)}>
                <ExternalLink size={10} /> View {a.result.name || a.result.id}
              </Link>
            )}
            {!a.success && a.error && <div style={{ fontSize: 11, opacity: 0.7 }}>{a.error}</div>}
          </div>
        ))}
      </div>
    )
  }

  function renderSuggestions(suggestions?: string[]) {
    if (!suggestions?.length) return null
    return (
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {suggestions.map((s, i) => (
          <button key={i} onClick={() => handleQuickPrompt(s)} disabled={loading}
            style={{
              padding: '4px 10px', borderRadius: 99, border: '1px solid var(--border)', background: 'var(--bg)',
              color: 'var(--text)', fontSize: 11, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1,
            }}
          >{s}</button>
        ))}
      </div>
    )
  }

  // ── Don't render if no tenant ────────────────────────────────────────────
  if (!tenantId) return null

  // ── Collapsed FAB ────────────────────────────────────────────────────────
  if (!open) {
    return (
      <button
        style={styles.fab}
        onClick={() => { setOpen(true); setMinimized(false) }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; e.currentTarget.style.boxShadow = '0 6px 32px rgba(63,138,67,0.45)' }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = '0 4px 24px rgba(63,138,67,0.35)' }}
        aria-label="Open Builder Bot"
        title="AI Builder — create agents, workflows & more"
      >
        <MessageCircle size={24} />
        <style jsx global>{`
          @keyframes builderSlideUp {
            from { opacity: 0; transform: translateY(16px) scale(0.96); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          @keyframes builderPulse {
            0%, 100% { box-shadow: 0 4px 24px rgba(63,138,67,0.35); }
            50% { box-shadow: 0 4px 36px rgba(190,189,4,0.5); }
          }
        `}</style>
      </button>
    )
  }

  // ── Minimized bar ────────────────────────────────────────────────────────
  if (minimized) {
    return (
      <div style={{
        position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 18px', borderRadius: 16,
        background: 'linear-gradient(135deg, var(--green) 0%, var(--yellow-light) 100%)',
        color: '#fff', boxShadow: '0 4px 24px rgba(63,138,67,0.35)',
        cursor: 'pointer', animation: 'builderSlideUp 0.25s ease-out',
      }} onClick={() => { setMinimized(false); setTimeout(() => inputRef.current?.focus(), 200) }}>
        <Sparkles size={16} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Builder Bot</span>
        <Maximize2 size={14} style={{ marginLeft: 4, opacity: 0.7 }} />
        <button onClick={e => { e.stopPropagation(); setOpen(false) }}
          style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', opacity: 0.7, padding: 2, marginLeft: 4 }}>
          <X size={14} />
        </button>
        <style jsx global>{`
          @keyframes builderSlideUp {
            from { opacity: 0; transform: translateY(16px) scale(0.96); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
        `}</style>
      </div>
    )
  }

  // ── Full panel ───────────────────────────────────────────────────────────
  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: 'linear-gradient(135deg, var(--green) 0%, var(--yellow-light) 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Sparkles size={15} style={{ color: '#fff' }} />
          </div>
          <div>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Builder Bot</span>
            {role && (
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 99,
                background: canCreateAnything ? 'rgba(63,138,67,0.15)' : 'rgba(255,255,255,0.08)',
                color: canCreateAnything ? 'var(--green)' : 'var(--text-muted)',
                marginLeft: 6, fontWeight: 600,
              }}>{role}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setMinimized(true)}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
            <Minimize2 size={15} />
          </button>
          <button onClick={() => setOpen(false)}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 6, borderRadius: 6 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div style={styles.messages}>
        {messages.map((msg, idx) => (
          <div key={msg.id} style={{ animation: 'builderSlideUp 0.2s ease-out' }}>
            {/* Role badge */}
            {msg.role !== 'user' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                {msg.role === 'assistant' && (
                  <div style={{
                    width: 20, height: 20, borderRadius: 6,
                    background: 'linear-gradient(135deg, var(--green) 0%, var(--yellow-light) 100%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}><Sparkles size={10} style={{ color: '#fff' }} /></div>
                )}
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.5 }}>
                  {msg.role === 'assistant' ? 'Builder' : 'System'}
                </span>
              </div>
            )}

            {/* Bubble */}
            <div style={{
              padding: msg.role === 'user' ? '8px 14px' : '0',
              borderRadius: 12,
              background: msg.role === 'user' ? 'var(--green)' : 'transparent',
              color: msg.role === 'user' ? '#fff' : 'var(--text)',
              maxWidth: msg.role === 'user' ? '80%' : '100%',
              marginLeft: msg.role === 'user' ? 'auto' : 0,
              fontSize: 13,
              lineHeight: 1.55,
              wordBreak: 'break-word',
            }}>
              {renderContent(msg.content)}

              {/* Quick prompts in welcome */}
              {msg.id === 'welcome' && ctx?.hasLlm && canCreateAnything && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {canCreate.agent && (
                    <button onClick={() => handleQuickPrompt('Create a support agent that handles customer inquiries')} disabled={loading}
                      style={quickBtnStyle}>🤖 Create a support agent</button>
                  )}
                  {canCreate.workflow && (
                    <button onClick={() => handleQuickPrompt('Build a workflow that sends a Slack notification when a new lead comes in')} disabled={loading}
                      style={quickBtnStyle}>⚡ Build a notification workflow</button>
                  )}
                  {canCreate.knowledgeBase && (
                    <button onClick={() => handleQuickPrompt('Create a knowledge base for our product documentation')} disabled={loading}
                      style={quickBtnStyle}>📚 Set up a knowledge base</button>
                  )}
                </div>
              )}
            </div>

            {renderActions(msg.actions)}
            {renderSuggestions(msg.suggestions)}
          </div>
        ))}

        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', opacity: 0.5 }} />
            <span style={{ fontSize: 12, opacity: 0.4 }}>
              {attachments.length > 0 ? 'Uploading and processing file...' : 'Thinking...'}
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={styles.inputArea}>
        <form onSubmit={sendMessage} style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          background: 'var(--bg)', borderRadius: 14,
          border: '1px solid var(--border)',
          padding: '6px',
        }}>
          {/* Attachments Preview inside input form */}
          {attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 6, padding: '4px 8px' }}>
              {attachments.map((att, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--bg-card, #fff)', padding: '4px 8px', borderRadius: 4, fontSize: 11, border: '1px solid var(--border)', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <span>📎 {att.name}</span>
                  <button type="button" onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--danger)', display: 'flex' }}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingLeft: 8 }}>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = (ev) => {
                  const base64 = (ev.target?.result as string).split(',')[1]
                  setAttachments(prev => [...prev, { name: file.name, type: file.type || 'application/octet-stream', contentBase64: base64 }])
                }
                reader.readAsDataURL(file)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              title="Attach file"
              style={{
                background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: '4px'
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={16} />
            </button>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={canCreateAnything ? 'Ask me to build something...' : 'Ask me about resources...'}
              disabled={loading}
              style={{
                flex: 1, border: 'none', background: 'transparent', outline: 'none',
                fontSize: 13, color: 'var(--text)', padding: '6px 0',
              }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
            />
            <button type="submit" disabled={!input.trim() || loading} style={{
              width: 32, height: 32, borderRadius: 10, border: 'none',
              background: input.trim() && !loading ? 'linear-gradient(135deg, var(--green) 0%, var(--yellow-light) 100%)' : 'var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
              flexShrink: 0, transition: 'all 0.15s',
            }}>
              {loading ? <Loader2 size={14} style={{ color: '#fff', animation: 'spin 1s linear infinite' }} /> : <ArrowUp size={14} style={{ color: '#fff' }} />}
            </button>
          </div>
        </form>
      </div>

      <style jsx global>{`
        @keyframes builderSlideUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

const quickBtnStyle: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 10, border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text)', fontSize: 12,
  textAlign: 'left', cursor: 'pointer',
}
