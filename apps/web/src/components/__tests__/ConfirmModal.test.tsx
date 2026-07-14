import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ConfirmModal, useConfirm } from '@/components/ConfirmModal'
import { useState } from 'react'

describe('ConfirmModal Component', () => {
  it('renders nothing when open is false', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    const { container } = render(
      <ConfirmModal
        open={false}
        title="Delete Item?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    expect(container.firstChild).toBeNull()
  })

  it('renders modal content correctly when open is true', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmModal
        open={true}
        title="Delete Item?"
        description="Are you sure you want to delete this item?"
        confirmLabel="Yes, delete it"
        cancelLabel="No, keep it"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Delete Item?')).toBeInTheDocument()
    expect(screen.getByText('Are you sure you want to delete this item?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Yes, delete it' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'No, keep it' })).toBeInTheDocument()
  })

  it('calls onConfirm when confirm button is clicked', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmModal
        open={true}
        title="Confirm action"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when cancel button is clicked', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmModal
        open={true}
        title="Confirm action"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when clicking on the overlay background', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmModal
        open={true}
        title="Confirm action"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    // The overlay is the outermost div with role="dialog"
    const overlay = screen.getByRole('dialog')
    fireEvent.click(overlay)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('disables buttons and shows working label when loading is true', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmModal
        open={true}
        title="Confirm action"
        loading={true}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    const confirmButton = screen.getByRole('button', { name: 'Working…' })
    const cancelButton = screen.getByRole('button', { name: 'Cancel' })

    expect(confirmButton).toBeDisabled()
    expect(cancelButton).toBeDisabled()
  })

  it('triggers onConfirm when Enter key is pressed', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmModal
        open={true}
        title="Confirm action"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('triggers onCancel when Escape key is pressed', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmModal
        open={true}
        title="Confirm action"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('useConfirm hook', () => {
  function TestComponent({ onResult }: { onResult: (v: boolean) => void }) {
    const { confirm, ConfirmDialog } = useConfirm()
    return (
      <div>
        <button onClick={async () => {
          const res = await confirm({ title: 'Async Title' })
          onResult(res)
        }}>Trigger</button>
        {ConfirmDialog}
      </div>
    )
  }

  it('resolves true when confirm is clicked', async () => {
    const onResult = vi.fn()
    render(<TestComponent onResult={onResult} />)

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }))

    // Modal should now be open
    expect(screen.getByText('Async Title')).toBeInTheDocument()

    // Click confirm
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(true)
    })
    expect(screen.queryByText('Async Title')).not.toBeInTheDocument()
  })

  it('resolves false when cancel is clicked', async () => {
    const onResult = vi.fn()
    render(<TestComponent onResult={onResult} />)

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }))

    // Click cancel
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(false)
    })
    expect(screen.queryByText('Async Title')).not.toBeInTheDocument()
  })
})
