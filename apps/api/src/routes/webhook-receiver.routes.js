// apps/api/src/routes/webhook-receiver.routes.js
// Webhook receiver — accepts incoming webhooks from external systems
//
// Endpoints:
//   POST /tenants/:tenantId/webhooks/receive/:token   — Receive webhook event
//   GET  /tenants/:tenantId/webhooks/events           — List recent events
//   GET  /tenants/:tenantId/webhooks/events/:eventId  — Get event with full payload
//
// Auth: POST uses token-based auth (no JWT). GET routes require JWT auth.

import { query } from '../db/pool.js'
import { errorResponse, AppError } from '../utils/errors.js'
import crypto from 'node:crypto'

export default async function webhookReceiverRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // ── Receive webhook event ─────────────────────────────────────────────────
  // POST /tenants/:tenantId/webhooks/receive/:token
  // No JWT auth — verified via token + optional HMAC signature
  fastify.post('/tenants/:tenantId/webhooks/receive/:token', async (request, reply) => {
    try {
      const { tenantId, token } = request.params
      const payload = request.body
      const signature = request.headers['x-webhook-signature'] || ''
      const source = request.headers['x-webhook-source'] || 'unknown'

      // Verify the token matches a registered webhook source
      const { rows: [sourceConfig] } = await query(
        `SELECT id, name, secret, tenant_id, require_hmac FROM webhook_sources 
         WHERE tenant_id = $1 AND token = $2 AND active = true`,
        [tenantId, token]
      )

      if (!sourceConfig) {
        return reply.code(401).send({ error: 'Invalid or inactive webhook token' })
      }

      // Verify HMAC signature if required or if a secret is provided
      if (sourceConfig.require_hmac && !signature) {
        return reply.code(401).send({ error: 'Missing HMAC signature: this webhook source requires a valid signature' })
      }

      if (sourceConfig.secret && signature) {
        const computed = crypto
          .createHmac('sha256', sourceConfig.secret)
          .update(JSON.stringify(payload))
          .digest('hex')
        // Use constant-time comparison to prevent timing oracle attacks
        const computedBuf = Buffer.from(computed)
        const signatureBuf = Buffer.from(signature)
        const valid = computedBuf.length === signatureBuf.length &&
          crypto.timingSafeEqual(computedBuf, signatureBuf)
        if (!valid) {
          return reply.code(401).send({ error: 'Invalid HMAC signature' })
        }
      }


      // Store the event
      const { rows: [event] } = await query(
        `INSERT INTO webhook_events (source_id, tenant_id, source, payload, headers, signature)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [sourceConfig.id, tenantId, source, JSON.stringify(payload), JSON.stringify(request.headers), signature]
      )

      return {
        success: true,
        event_id: event.id,
        created_at: event.created_at
      }
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── List recent webhook events ────────────────────────────────────────────
  // GET /tenants/:tenantId/webhooks/events
  fastify.get('/tenants/:tenantId/webhooks/events', auth, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const limit = Math.min(parseInt(request.query.limit) || 20, 100)

      const { rows } = await query(
        `SELECT we.id, we.source, we.created_at, ws.name as source_name
         FROM webhook_events we
         JOIN webhook_sources ws ON we.source_id = ws.id
         WHERE we.tenant_id = $1
         ORDER BY we.created_at DESC
         LIMIT $2`,
        [tenantId, limit]
      )

      return { events: rows }
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── Get a specific webhook event ──────────────────────────────────────────
  // GET /tenants/:tenantId/webhooks/events/:eventId
  fastify.get('/tenants/:tenantId/webhooks/events/:eventId', auth, async (request, reply) => {
    try {
      const { tenantId, eventId } = request.params

      const { rows: [event] } = await query(
        `SELECT we.*, ws.name as source_name
         FROM webhook_events we
         JOIN webhook_sources ws ON we.source_id = ws.id
         WHERE we.id = $1 AND we.tenant_id = $2`,
        [eventId, tenantId]
      )

      if (!event) {
        return reply.code(404).send({ error: 'Event not found' })
      }

      return event
    } catch (err) {
      return errorResponse(reply, err)
    }
  })
}
