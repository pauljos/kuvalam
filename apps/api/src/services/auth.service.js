// apps/api/src/services/auth.service.js
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { query } from '../db/pool.js'
import { hashToken, generateTokens } from '../utils/jwt.js'
import { sendEmail } from '../utils/email.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'

export async function registerUser({ email, password, name }) {
  const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
  if (existing.rows.length > 0) {
    throw new AppError('EMAIL_ALREADY_EXISTS', 'An account with this email already exists', 409)
  }

  const passwordHash = await bcrypt.hash(password, 12)

  const { rows } = await query(
    `INSERT INTO users (email, password_hash, name, email_verified)
     VALUES ($1, $2, $3, true)
     RETURNING id, email, name, created_at`,
    [email.toLowerCase(), passwordHash, name]
  )

  const user = rows[0]

  // Send welcome email (non-blocking)
  sendEmail({
    to: email,
    subject: 'Welcome to Kuvalam',
    html: `<h2>Welcome to Kuvalam, ${name}!</h2><p>Your account is ready. Sign in to get started.</p>`
  }).catch(() => {})

  await auditLog({ eventType: 'user.registered', actorId: user.id, actorType: 'USER', action: 'REGISTER' })

  return { userId: user.id, email: user.email, message: 'Account created successfully' }
}

export async function loginUser({ email, password, ip }) {
  const { rows } = await query(
    `SELECT id, email, name, password_hash, email_verified, mfa_enabled, is_system_admin
     FROM users WHERE email = $1`,
    [email.toLowerCase()]
  )

  if (rows.length === 0) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401)
  }

  const user = rows[0]
  const validPassword = await bcrypt.compare(password, user.password_hash)
  if (!validPassword) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401)
  }

  // Get user's tenants
  const { rows: memberships } = await query(
    `SELECT tm.role, tm.status, t.id, t.name, t.slug, t.plan
     FROM tenant_members tm
     JOIN tenants t ON t.id = tm.tenant_id
     WHERE tm.user_id = $1 AND tm.status = 'ACTIVE'`,
    [user.id]
  )

  // Generate tokens
  const { accessPayload, refreshToken } = generateTokens(user, memberships[0] || null)

  // Store hashed refresh token
  const tokenHash = hashToken(refreshToken)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, tokenHash, expiresAt]
  )

  // Update last login
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id])
  await auditLog({ eventType: 'user.logged_in', actorId: user.id, actorType: 'USER', action: 'LOGIN', metadata: { ip } })

  return {
    accessPayload,   // route handler will sign this with fastify-jwt
    refreshToken,
    user: { id: user.id, email: user.email, name: user.name, isSystemAdmin: user.is_system_admin || false },
    tenants: memberships.map(m => ({ id: m.id, name: m.name, slug: m.slug, plan: m.plan, role: m.role }))
  }
}

export async function refreshAccessToken(refreshToken) {
  const tokenHash = hashToken(refreshToken)
  const { rows } = await query(
    `SELECT rt.*, u.id as user_id, u.email, u.name, u.is_system_admin
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked = false AND rt.expires_at > NOW()`,
    [tokenHash]
  )

  if (rows.length === 0) {
    throw new AppError('REFRESH_TOKEN_INVALID', 'Invalid or expired refresh token', 401)
  }

  const { rows: memberships } = await query(
    `SELECT tm.role, t.id, t.name, t.slug, t.plan
     FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id
     WHERE tm.user_id = $1 AND tm.status = 'ACTIVE' LIMIT 1`,
    [rows[0].user_id]
  )

  const user = { id: rows[0].user_id, email: rows[0].email, name: rows[0].name, is_system_admin: rows[0].is_system_admin }
  const { accessPayload } = generateTokens(user, memberships[0] || null)

  return { accessPayload, expiresAt: new Date(Date.now() + 15 * 60 * 1000) }
}

export async function logoutUser(refreshToken) {
  if (!refreshToken) return
  const tokenHash = hashToken(refreshToken)
  await query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [tokenHash])
}
