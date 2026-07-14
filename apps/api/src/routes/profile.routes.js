// apps/api/src/routes/profile.routes.js
// User profile management + password reset flow.

import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { query } from '../db/pool.js'
import { AppError, errorResponse } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'
import { sendEmail } from '../utils/email.js'

const RESET_TOKEN_TTL_MINUTES = 30

export default async function profileRoutes(fastify) {
  // ─── Authenticated routes ─────────────────────────────────────────────────

  fastify.get('/profile', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    try {
      const { rows: [user] } = await query(
        `SELECT id, email, name, email_verified, mfa_enabled, is_system_admin, created_at
         FROM users WHERE id = $1`,
        [req.user.sub]
      )
      if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
      return reply.send({ success: true, data: user })
    } catch (err) { return errorResponse(reply, err) }
  })

  fastify.patch('/profile', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    try {
      const { name } = req.body || {}
      if (!name || name.trim().length < 1) {
        throw new AppError('INVALID_NAME', 'Name is required', 400)
      }
      const { rows: [user] } = await query(
        `UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2
         RETURNING id, email, name, is_system_admin`,
        [name.trim(), req.user.sub]
      )
      return reply.send({ success: true, data: user })
    } catch (err) { return errorResponse(reply, err) }
  })

  fastify.post('/profile/change-password', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    try {
      const { currentPassword, newPassword } = req.body || {}
      if (!currentPassword || !newPassword) {
        throw new AppError('MISSING_FIELDS', 'currentPassword and newPassword are required', 400)
      }
      if (newPassword.length < 8) {
        throw new AppError('WEAK_PASSWORD', 'New password must be at least 8 characters', 400)
      }

      const { rows: [user] } = await query(
        `SELECT id, password_hash FROM users WHERE id = $1`,
        [req.user.sub]
      )
      if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)

      const valid = await bcrypt.compare(currentPassword, user.password_hash)
      if (!valid) throw new AppError('BAD_PASSWORD', 'Current password is incorrect', 401)

      const newHash = await bcrypt.hash(newPassword, 12)
      await query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [newHash, user.id]
      )

      // Revoke all refresh tokens for this user so other sessions get logged out
      await query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [user.id])

      await auditLog({
        eventType: 'user.password_changed',
        actorId: user.id,
        actorType: 'USER',
        resourceType: 'User',
        resourceId: user.id,
        action: 'CHANGE_PASSWORD',
      })

      return reply.send({ success: true, data: { changed: true } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ─── Password reset (public) ──────────────────────────────────────────────

  fastify.post('/auth/forgot-password', {
    config: {
      // Strict rate limit — 5 password reset requests per hour per IP.
      // Prevents enumeration + email bombing.
      rateLimit: { max: 5, timeWindow: '1 hour' }
    }
  }, async (req, reply) => {
    try {
      const { email } = req.body || {}
      if (!email) throw new AppError('MISSING_EMAIL', 'email is required', 400)

      // Always return success (do not disclose whether an email exists)
      const { rows: [user] } = await query(
        `SELECT id, email, name FROM users WHERE email = $1`,
        [email.toLowerCase()]
      )
      if (!user) return reply.send({ success: true, data: { sent: true } })

      // Generate token, hash it for DB storage
      const rawToken = crypto.randomBytes(32).toString('hex')
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000)

      // Store in refresh_tokens table with a `reset:` prefix so it's clearly a reset token
      await query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, `reset:${tokenHash}`, expiresAt]
      )

      const appUrl = process.env.APP_URL || 'http://localhost:3000'
      const link = `${appUrl}/reset-password?token=${rawToken}`

      await sendEmail({
        to: user.email,
        subject: 'Reset your Kuvalam password',
        text: `Hi ${user.name || ''},\n\nSomeone (hopefully you) requested a password reset for your Kuvalam account.\n\nReset link (expires in ${RESET_TOKEN_TTL_MINUTES} minutes):\n${link}\n\nIf you didn't request this, you can ignore this email.\n\n— Kuvalam`,
        html: `<p>Hi ${user.name || ''},</p><p>Someone (hopefully you) requested a password reset for your Kuvalam account.</p><p><a href="${link}">Click here to reset your password</a> (link expires in ${RESET_TOKEN_TTL_MINUTES} minutes).</p><p>If you didn't request this, you can ignore this email.</p>`,
      })

      await auditLog({
        eventType: 'user.password_reset_requested',
        actorId: user.id,
        actorType: 'USER',
        resourceType: 'User',
        resourceId: user.id,
        action: 'REQUEST_PASSWORD_RESET',
      })

      return reply.send({ success: true, data: { sent: true } })
    } catch (err) { return errorResponse(reply, err) }
  })

  fastify.post('/auth/reset-password', {
    config: {
      // Prevent reset-token brute force
      rateLimit: { max: 10, timeWindow: '15 minutes' }
    }
  }, async (req, reply) => {
    try {
      const { token, newPassword } = req.body || {}
      if (!token || !newPassword) {
        throw new AppError('MISSING_FIELDS', 'token and newPassword are required', 400)
      }
      if (newPassword.length < 8) {
        throw new AppError('WEAK_PASSWORD', 'Password must be at least 8 characters', 400)
      }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

      const result = await query(
        `SELECT id, user_id FROM refresh_tokens
         WHERE token_hash = $1 AND revoked = false AND expires_at > NOW()`,
        [`reset:${tokenHash}`]
      )
      // Do a dummy bcrypt to keep response time roughly constant even on invalid tokens.
      // Otherwise an attacker could time-probe which tokens hit a row.
      if (result.rows.length === 0) {
        await bcrypt.hash('dummy-token-timing-guard-value', 12).catch(() => {})
        throw new AppError('INVALID_TOKEN', 'Reset link is invalid or expired', 400)
      }
      const row = result.rows[0]

      const newHash = await bcrypt.hash(newPassword, 12)
      await query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [
        newHash,
        row.user_id,
      ])

      // Revoke the reset token + all outstanding refresh tokens
      await query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [row.user_id])

      await auditLog({
        eventType: 'user.password_reset_completed',
        actorId: row.user_id,
        actorType: 'USER',
        resourceType: 'User',
        resourceId: row.user_id,
        action: 'COMPLETE_PASSWORD_RESET',
      })

      return reply.send({ success: true, data: { reset: true } })
    } catch (err) { return errorResponse(reply, err) }
  })
}
