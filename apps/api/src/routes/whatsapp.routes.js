// apps/api/src/routes/whatsapp.routes.js
// WhatsApp webhook receiver + session management endpoints
//
// Endpoints:
//   GET  /api/v1/tenants/:tenantId/whatsapp/webhook   — Meta webhook verification
//   POST /api/v1/tenants/:tenantId/whatsapp/webhook   — Receive messages from Meta
//   GET  /api/v1/tenants/:tenantId/whatsapp/sessions   — List sessions (JWT auth)
//   POST /api/v1/tenants/:tenantId/whatsapp/deactivate — Deactivate session (JWT auth)

import { query } from '../db/pool.js'
import {
  verifyWebhook,
  processWebhook,
  sendMessage,
  getSession,
  getSessionHistory,
  deactivateSession,
} from '../services/whatsapp.service.js'

export default async function whatsappRoutes(fastify) {
  // ── Webhook Verification (GET) — Meta calls this to verify the endpoint ──
  // No auth required — Meta verifies via hub.verify_token
  fastify.get('/tenants/:tenantId/whatsapp/webhook', async (request, reply) => {
    try {
      const { tenantId } = request.params
      const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query

      const result = await verifyWebhook({ mode, token, challenge, tenantId })

      if (!result.verified) {
        return reply.code(403).send({ success: false, error: result.error })
      }

      // Meta expects the challenge integer as the response body
      return reply.type('text/plain').send(String(result.challenge))
    } catch (err) {
      request.log.error({ err }, 'WhatsApp webhook verification failed')
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ── Receive Messages (POST) — Meta sends messages here ──────────────────
  // No JWT auth — verified via X-Hub-Signature-256 HMAC
  fastify.post('/tenants/:tenantId/whatsapp/webhook', {
    config: {
      // Raw body needed for HMAC verification
      rawBody: true,
    },
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const signature = request.headers['x-hub-signature-256'] || ''

      // Get raw body for signature verification
      let rawBody = ''
      if (typeof request.body === 'string') {
        rawBody = request.body
      } else if (Buffer.isBuffer(request.body)) {
        rawBody = request.body.toString('utf-8')
      } else {
        rawBody = JSON.stringify(request.body)
      }

      // Parse body if it's a string
      const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body

      const result = await processWebhook({ body, signature, tenantId, rawBody })

      if (!result.success) {
        return reply.code(result.error === 'Invalid webhook signature' ? 401 : 500)
          .send({ success: false, error: result.error })
      }

      return reply.code(200).send(result)
    } catch (err) {
      request.log.error({ err }, 'WhatsApp webhook processing failed')
      // Always return 200 to Meta so they don't retry — we handle errors internally
      return reply.code(200).send({ success: false, error: err.message })
    }
  })

  // ── List WhatsApp Sessions (JWT auth) ────────────────────────────────────
  fastify.get('/tenants/:tenantId/whatsapp/sessions', {
    preValidation: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const { rows } = await query(
        `SELECT ws.*,
          (SELECT content FROM whatsapp_messages
           WHERE session_id = ws.id ORDER BY created_at DESC LIMIT 1) as last_message
         FROM whatsapp_sessions ws
         WHERE ws.tenant_id = $1
         ORDER BY ws.last_message_at DESC NULLS LAST`,
        [tenantId]
      )
      return { success: true, data: { sessions: rows } }
    } catch (err) {
      request.log.error({ err }, 'Failed to list WhatsApp sessions')
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ── Get Session Messages (JWT auth) ──────────────────────────────────────
  fastify.get('/tenants/:tenantId/whatsapp/sessions/:sessionId/messages', {
    preValidation: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const { tenantId, sessionId } = request.params
      const session = await getSession(sessionId, tenantId)
      if (!session) {
        return reply.code(404).send({ success: false, error: 'Session not found' })
      }
      const messages = await getSessionHistory(sessionId)
      return { success: true, data: { session, messages } }
    } catch (err) {
      request.log.error({ err }, 'Failed to get session messages')
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ── Deactivate Session (JWT auth) ────────────────────────────────────────
  fastify.post('/tenants/:tenantId/whatsapp/sessions/:sessionId/deactivate', {
    preValidation: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const { tenantId, sessionId } = request.params
      await deactivateSession(sessionId, tenantId)
      return { success: true, message: 'Session deactivated' }
    } catch (err) {
      request.log.error({ err }, 'Failed to deactivate session')
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ── Send Message (JWT auth — manual/test endpoint) ───────────────────────
  fastify.post('/tenants/:tenantId/whatsapp/send', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['to', 'text'],
        properties: {
          to: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const { to, text } = request.body
      const result = await sendMessage({ tenantId, to, text })
      return result
    } catch (err) {
      request.log.error({ err }, 'Failed to send WhatsApp message')
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}
