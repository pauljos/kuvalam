'use client'
import { useEffect, useRef, useState, useCallback } from 'react'

interface PromptModalProps {
  open: boolean
  title: string
  label?: string
  placeholder?: string
  defaultValue?: string
  required?: boolean
  confirmLabel?: string
  cancelLabel?: string
  loading?: boolean
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function PromptModal({
  open,
  title,
  label,
  placeholder,
  defaultValue = '',
  required = true,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  loading = false,
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) {
      setValue(defaultValue)
      setTimeout(() => inputRef.current?.focus(), 40)
    }
  }, [open, defaultValue])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel()
      if (e.key === 'Enter' && !loading && (!required || value.trim())) {
        onConfirm(value.trim())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, loading, value, required, onCancel, onConfirm])

  if (!open) return null

  const canSubmit = !required || value.trim().length > 0

  return (
    <div
      onClick={() => !loading && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-title"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20,
        animation: 'fadeIn 0.15s ease-out',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, padding: 28,
          width: '100%', maxWidth: 420,
          boxShadow: '0 20px 60px rgba(0,0,0,0.24)',
          animation: 'slideUp 0.2s ease-out',
        }}
      >
        <h2 id="prompt-title" style={{ fontSize: 17, fontWeight: 800, margin: 0, marginBottom: 16, color: 'var(--text)' }}>
          {title}
        </h2>
        {label && (
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-sub)', marginBottom: 6 }}>
            {label}
          </label>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={placeholder}
          className="input"
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-secondary" onClick={onCancel} disabled={loading} type="button">
            {cancelLabel}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => canSubmit && onConfirm(value.trim())}
            disabled={loading || !canSubmit}
            type="button"
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
    </div>
  )
}

// ─── Hook: usePrompt ──────────────────────────────────────────────────────
// Usage:
//   const { prompt, PromptDialog } = usePrompt()
//   const reason = await prompt({ title: 'Reason for suspension' })
//   if (!reason) return // user cancelled
//   {PromptDialog}
import { useState as _useState } from 'react'

export interface PromptOptions {
  title: string
  label?: string
  placeholder?: string
  defaultValue?: string
  required?: boolean
  confirmLabel?: string
}

export function usePrompt() {
  const [state, setState] = _useState<{
    open: boolean
    options: PromptOptions
    resolve?: (v: string | null) => void
  }>({ open: false, options: { title: '' } })

  const prompt = useCallback((options: PromptOptions): Promise<string | null> => {
    return new Promise(resolve => {
      setState({ open: true, options, resolve })
    })
  }, [])

  const handleConfirm = useCallback((value: string) => {
    state.resolve?.(value)
    setState(s => ({ ...s, open: false }))
  }, [state])

  const handleCancel = useCallback(() => {
    state.resolve?.(null)
    setState(s => ({ ...s, open: false }))
  }, [state])

  const PromptDialog = (
    <PromptModal
      open={state.open}
      title={state.options.title}
      label={state.options.label}
      placeholder={state.options.placeholder}
      defaultValue={state.options.defaultValue}
      required={state.options.required}
      confirmLabel={state.options.confirmLabel}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  )

  return { prompt, PromptDialog }
}
