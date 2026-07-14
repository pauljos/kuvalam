// apps/api/src/utils/jwt.js
import { createHash, randomBytes, createHmac } from 'crypto'

const JWT_SECRET = process.env.JWT_SECRET || 'kuvalam-dev-secret-change-in-production'

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * generateTokens — returns an access token payload + refresh token string.
 * The actual JWT signing is done by fastify-jwt in the route handler.
 */
export function generateTokens(user, tenantMembership) {
  const accessPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    tenantId: tenantMembership?.id || null,
    role: tenantMembership?.role || null,
    plan: tenantMembership?.plan || 'TRIAL',
    isSystemAdmin: user.is_system_admin || false
  }
  const refreshToken = randomBytes(64).toString('hex')
  return { accessPayload, refreshToken }
}
