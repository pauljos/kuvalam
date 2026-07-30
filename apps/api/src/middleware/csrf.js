// ═══════════════════════════════════════════════════════════════════════════════
// CSRF Protection Middleware — Origin/Referer validation
// ═══════════════════════════════════════════════════════════════════════════════

import { AppError } from '../utils/errors.js'

/**
 * Validate Origin or Referer header on state-changing requests
 * This provides CSRF protection for cookie-based authentication
 */
export async function validateOrigin(request, reply) {
  // Only check on state-changing methods
  const method = request.method.toUpperCase()
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return
  }

  // Skip validation for public endpoints (webhooks, OAuth callbacks, etc.)
  // Use exact match or proper prefix-with-separator so a crafted URL like
  // /api/v1/tenants/x/settings/auth/login doesn't accidentally bypass CSRF.
  const publicPaths = [
    '/api/v1/auth/login',
    '/auth/login',
    '/auth/register',
    '/api/v1/auth/register',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
    '/oauth/callback',
    '/webhooks/receive',
    '/triggers/webhook',
    '/whatsapp/webhook',
    '/telegram/webhook',
    '/health/messaging',
  ]

  const urlPath = request.url.split('?')[0] // strip query string
  const isPublicPath = publicPaths.some(path =>
    urlPath === path ||
    urlPath.startsWith(path + '/') ||
    urlPath.startsWith(path + '?')
  )
  if (isPublicPath) {
    return
  }

  // Get allowed origins from environment
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',')

  // Check Origin header first (preferred)
  const origin = request.headers.origin
  if (origin) {
    if (!allowedOrigins.includes(origin)) {
      throw new AppError('CSRF_VALIDATION_FAILED', 'Invalid origin', 403)
    }
    return
  }

  // Fallback to Referer header
  const referer = request.headers.referer
  if (referer) {
    try {
      const refererUrl = new URL(referer)
      const refererOrigin = `${refererUrl.protocol}//${refererUrl.host}`
      if (!allowedOrigins.includes(refererOrigin)) {
        throw new AppError('CSRF_VALIDATION_FAILED', 'Invalid referer', 403)
      }
      return
    } catch (err) {
      throw new AppError('CSRF_VALIDATION_FAILED', 'Invalid referer format', 403)
    }
  }

  // If neither header is present, reject the request
  // (legitimate browsers always send at least one of these on cross-origin requests)
  throw new AppError('CSRF_VALIDATION_FAILED', 'Missing origin/referer header', 403)
}
