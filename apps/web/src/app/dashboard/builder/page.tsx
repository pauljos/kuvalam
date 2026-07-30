'use client'
import { useEffect } from 'react'
import { Sparkles, ArrowDownRight } from 'lucide-react'

export default function BuilderPage() {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('kuvalam:open-builder'))
  }, [])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '60vh', gap: 24, padding: 40,
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: 20,
        background: 'linear-gradient(135deg, var(--green) 0%, var(--yellow-light) 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 8px 32px rgba(63,138,67,0.3)',
      }}>
        <Sparkles size={36} style={{ color: '#fff' }} />
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: 'var(--text)' }}>
        Builder Bot
      </h1>
      <p style={{ fontSize: 15, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 400, lineHeight: 1.6 }}>
        The Builder Bot has opened in the bottom-right corner.
        Use it to create agents, workflows, knowledge bases, and more — all through natural conversation.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'bounce 2s ease-in-out infinite' }}>
        <ArrowDownRight size={18} style={{ color: 'var(--green)' }} />
        <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>Look bottom-right ↓</span>
      </div>
      <style jsx global>{`
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(6px); }
        }
      `}</style>
    </div>
  )
}
