'use client'
import { useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'

interface FeedbackModalProps {
  open: boolean
  onClose: () => void
  onSubmitted?: () => void
  title?: string
  subtitle?: string
  agentId?: string
  approvalId?: string
}

const SUGGESTED_TAGS = ['Accurate', 'Fast', 'Helpful', 'Off-topic', 'Slow', 'Wrong answer', 'Hallucination', 'Perfect']

export function FeedbackModal({ open, onClose, onSubmitted, title = 'How did the agent do?', subtitle, agentId, approvalId }: FeedbackModalProps) {
  const { tenantId, toast } = useApp()
  const [rating, setRating] = useState<number>(0)
  const [hoverRating, setHoverRating] = useState<number>(0)
  const [text, setText] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  function toggleTag(t: string) {
    setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }

  async function submit() {
    if (rating === 0) {
      toast('error', 'Rating required', 'Please pick a star rating first.')
      return
    }
    setSubmitting(true)
    try {
      await api.submitFeedback(tenantId, {
        qualityRating: rating,
        feedbackText: text.trim() || undefined,
        feedbackTags: tags.length ? tags : undefined,
        agentId,
        approvalId,
      })
      toast('success', 'Thanks for your feedback!', 'This helps us improve your agents.')
      setRating(0); setText(''); setTags([])
      onSubmitted?.()
      onClose()
    } catch (err: any) {
      toast('error', 'Failed to submit', err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999, padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, padding: 32,
          width: '100%', maxWidth: 480,
          boxShadow: '0 20px 60px rgba(0,0,0,0.24)',
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0, marginBottom: 4 }}>{title}</h2>
        {subtitle && <p style={{ fontSize: 13, color: 'var(--text-muted, #6b7280)', margin: 0, marginBottom: 20 }}>{subtitle}</p>}
        {!subtitle && <div style={{ height: 20 }} />}

        {/* Stars */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 20 }}>
          {[1, 2, 3, 4, 5].map(n => {
            const filled = (hoverRating || rating) >= n
            return (
              <button
                key={n}
                type="button"
                onMouseEnter={() => setHoverRating(n)}
                onMouseLeave={() => setHoverRating(0)}
                onClick={() => setRating(n)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                  fontSize: 36, lineHeight: 1,
                  color: filled ? '#fbbf24' : '#d1d5db',
                  transition: 'transform 0.1s',
                  transform: filled ? 'scale(1.05)' : 'scale(1)',
                }}
                aria-label={`${n} star${n > 1 ? 's' : ''}`}
              >
                ★
              </button>
            )
          })}
        </div>
        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted, #6b7280)', marginBottom: 20, minHeight: 16 }}>
          {rating === 5 && '🎉 Excellent!'}
          {rating === 4 && '👍 Good'}
          {rating === 3 && '👌 Okay'}
          {rating === 2 && '👎 Poor'}
          {rating === 1 && '⚠️ Very bad'}
        </div>

        {/* Tags */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-muted, #6b7280)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Tags (optional)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SUGGESTED_TAGS.map(t => (
              <button
                key={t}
                type="button"
                onClick={() => toggleTag(t)}
                style={{
                  padding: '5px 12px', borderRadius: 999,
                  border: `1px solid ${tags.includes(t) ? 'var(--green, #70880e)' : '#e5e7eb'}`,
                  background: tags.includes(t) ? 'rgba(112,136,14,0.08)' : '#fff',
                  color: tags.includes(t) ? 'var(--green, #70880e)' : '#374151',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Text */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--text-muted, #6b7280)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Comments (optional)</label>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="What went well? What could improve?"
            rows={3}
            className="input"
            style={{ resize: 'vertical', minHeight: 70 }}
          />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Skip</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting || rating === 0}>
            {submitting ? 'Submitting…' : 'Submit feedback'}
          </button>
        </div>
      </div>
    </div>
  )
}
