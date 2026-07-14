import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppProvider, useApp } from '@/lib/context'
import { useRouter } from 'next/navigation'

// Helper component to interact with useApp context
function TestConsumer() {
  const { user, tenant, tenants, setTenant, toast, logout } = useApp()
  return (
    <div>
      <div data-testid="user">{user ? user.name : 'No User'}</div>
      <div data-testid="tenant">{tenant ? tenant.name : 'No Tenant'}</div>
      <div data-testid="tenants-count">{tenants.length}</div>
      <button onClick={() => setTenant({ id: 't2', name: 'Tenant 2' })}>Set Tenant 2</button>
      <button onClick={() => toast('success', 'Success Title', 'Success Message')}>Show Toast</button>
      <button onClick={logout}>Logout</button>
    </div>
  )
}

describe('AppProvider and useApp', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads initial state from localStorage', () => {
    const mockUser = { id: 'u1', name: 'Paul Joseph', email: 'paul@example.com' }
    const mockTenants = [
      { id: 't1', name: 'Tenant 1' },
      { id: 't2', name: 'Tenant 2' }
    ]
    localStorage.setItem('kuvalam_user', JSON.stringify(mockUser))
    localStorage.setItem('kuvalam_tenants', JSON.stringify(mockTenants))
    localStorage.setItem('kuvalam_tenant_id', 't1')

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>
    )

    expect(screen.getByTestId('user')).toHaveTextContent('Paul Joseph')
    expect(screen.getByTestId('tenant')).toHaveTextContent('Tenant 1')
    expect(screen.getByTestId('tenants-count')).toHaveTextContent('2')
  })

  it('updates active tenant via setTenant', () => {
    const mockTenants = [
      { id: 't1', name: 'Tenant 1' },
      { id: 't2', name: 'Tenant 2' }
    ]
    localStorage.setItem('kuvalam_tenants', JSON.stringify(mockTenants))

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>
    )

    // Trigger setTenant
    fireEvent.click(screen.getByText('Set Tenant 2'))

    expect(screen.getByTestId('tenant')).toHaveTextContent('Tenant 2')
    expect(localStorage.getItem('kuvalam_tenant_id')).toBe('t2')
  })

  it('displays toast alerts and automatically dismisses them', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>
    )

    // Trigger toast
    fireEvent.click(screen.getByText('Show Toast'))

    expect(screen.getByText('Success Title')).toBeInTheDocument()
    expect(screen.getByText('Success Message')).toBeInTheDocument()

    // Advance time by 4 seconds
    act(() => {
      vi.advanceTimersByTime(4000)
    })

    expect(screen.queryByText('Success Title')).not.toBeInTheDocument()
  })

  it('clears localStorage and redirects on logout', () => {
    localStorage.setItem('kuvalam_user', 'someUser')
    const mockRouter = useRouter()

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>
    )

    fireEvent.click(screen.getByText('Logout'))

    expect(localStorage.length).toBe(0)
    expect(mockRouter.push).toHaveBeenCalledWith('/')
  })
})
