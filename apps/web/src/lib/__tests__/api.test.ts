import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api } from '@/lib/api'

describe('API client (api.ts)', () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.window ? globalThis.window.location : undefined

  beforeEach(() => {
    globalThis.fetch = vi.fn()
    if (globalThis.window) {
      // Mock window.location in jsdom/happy-dom environment
      // @ts-ignore
      delete globalThis.window.location
      globalThis.window.location = { href: '' } as any
      localStorage.clear()
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (globalThis.window && originalLocation) {
      globalThis.window.location = originalLocation
    }
    vi.restoreAllMocks()
  })

  it('performs successful GET requests and returns data', async () => {
    const mockResponse = { data: { id: 'agent-1', name: 'Support Agent' } }
    
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    } as Response)

    const result = await api.getAgent('tenant-1', 'agent-1')

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/tenants/tenant-1/agents/agent-1',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })
    )
    expect(result).toEqual(mockResponse.data)
  })

  it('performs successful POST requests with body', async () => {
    const mockResponse = { data: { success: true } }
    const loginPayload = { email: 'test@example.com', password: 'password123' }

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    } as Response)

    const result = await api.login(loginPayload)

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(loginPayload),
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })
    )
    expect(result).toEqual(mockResponse.data)
  })

  it('throws an error with details when the request is not ok', async () => {
    const mockErrorResponse = {
      error: {
        message: 'Invalid email or password',
        code: 'AUTH_FAILED',
      },
    }

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => mockErrorResponse,
    } as Response)

    // Verify error properties in a single call to prevent consuming mock twice
    try {
      await api.login({ email: 'x', password: 'y' })
      expect.fail('api.login should have thrown an error')
    } catch (err: any) {
      expect(err.message).toBe('Invalid email or password')
      expect(err.status).toBe(400)
      expect(err.code).toBe('AUTH_FAILED')
    }
  })

  it('clears session and redirects to root on 401 Unauthorized response', async () => {
    const mockErrorResponse = {
      error: {
        message: 'Unauthorized',
        code: 'UNAUTHORIZED',
      },
    }

    localStorage.setItem('kuvalam_user', JSON.stringify({ id: '1', name: 'Paul' }))
    localStorage.setItem('kuvalam_tenants', JSON.stringify([{ id: 't1', name: 'Tenant' }]))
    localStorage.setItem('kuvalam_tenant_id', 't1')

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => mockErrorResponse,
    } as Response)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(api.me()).rejects.toThrow('Unauthorized')

    expect(warnSpy).toHaveBeenCalledWith('Session expired or unauthorized. Redirecting to login.')
    expect(localStorage.getItem('kuvalam_user')).toBeNull()
    expect(localStorage.getItem('kuvalam_tenants')).toBeNull()
    expect(localStorage.getItem('kuvalam_tenant_id')).toBeNull()
    expect(window.location.href).toBe('/')
  })
})
