// apps/api/src/routes/telegram.routes.js
// Telegram Bot API webhook receiver + session management endpoints
//
// Endpoints:
//   POST /api/v1/tenants/:tenantId/telegram/webhook[/:secretToken] — Receive updates from Telegram
//   GET  /api/v1/tenants/:tenantId/telegram/sessions        — List sessions (JWT auth)
//   GET  /api/v1/tenants/:tenantId/telegram/sessions/:id/messages — History (JWT auth)
//   POST /api/v1/tenants/:tenantId/telegram/sessions/:id/deactivate (JWT auth)
//   POST /api/v1/tenants/:tenantId/telegram/send            — Manual send (JWT auth)
//   GET  /api/v1/health/messaging                           — Health check for all messaging workers

import { query } from '../db/pool.js'
import {
  processWebhook,
  sendMessage,
  sendPhoto,
  sendInlineKeyboard,
  getSession,
  getSessionHistory,
  deactivateSession,
} from '../services/telegram.service.js'
import { getRedisConnection } from '../services/queue.service.js'

export default async function telegramRoutes(fastify) {
  // ── Receive Telegram Updates (POST) ─────────────────────────────────────
  // No JWT — verified via secret token in URL path or X-Telegram-Bot-Api-Secret-Token header
  // Supports both: /webhook and /webhook/<secretToken>
  fastify.post('/tenants/:tenantId/telegram/webhook', async (request, reply) => {
    try {
      const { tenantId } = request.params
      const body = request.body
      const secretToken = request.headers['x-telegram-bot-api-secret-token'] || ''

      const result = await processWebhook({ body, tenantId, secretToken })

      if (!result.success) {
        // Always return 200 to Telegram so they don't retry
        return reply.code(200).send({ ok: false, error: result.error })
      }

      return reply.code(200).send({ ok: true })
    } catch (err) {
      request.log.error({ err }, 'Telegram webhook processing failed')
      return reply.code(200).send({ ok: false, error: err.message })
    }
  })

  // Also support /webhook/<secretToken> path variant
  fastify.post('/tenants/:tenantId/telegram/webhook/:secretToken', async (request, reply) => {
    try {
      const { tenantId, secretToken } = request.params
      const body = request.body

      const result = await processWebhook({ body, tenantId, secretToken })

      if (!result.success) {
        return reply.code(200).send({ ok: false, error: result.error })
      }

      return reply.code(200).send({ ok: true })
    } catch (err) {
      request.log.error({ err }, 'Telegram webhook processing failed')
      return reply.code(200).send({ ok: false, error: err.message })
    }
  })

  // ── List Telegram Sessions (JWT auth) ────────────────────────────────────
  fastify.get('/tenants/:tenantId/telegram/sessions', {
    preValidation: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const { rows } = await query(
        `SELECT ts.*,
          (SELECT content FROM telegram_messages
           WHERE session_id = ts.id ORDER BY created_at DESC LIMIT 1) as last_message
         FROM telegram_sessions ts
         WHERE ts.tenant_id = $1
         ORDER BY ts.last_message_at DESC NULLS LAST`,
        [tenantId]
      )
      return { success: true, data: { sessions: rows } }
    } catch (err) {
      request.log.error({ err }, 'Failed to list Telegram sessions')
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ── Get Session Messages (JWT auth) ──────────────────────────────────────
  fastify.get('/tenants/:tenantId/telegram/sessions/:sessionId/messages', {
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
      request.log.error({ err }, 'Failed to get Telegram session messages')
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ── Deactivate Session (JWT auth) ────────────────────────────────────────
  fastify.post('/tenants/:tenantId/telegram/sessions/:sessionId/deactivate', {
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
  fastify.post('/tenants/:tenantId/telegram/send', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['chatId', 'text'],
        properties: {
          chatId: { type: 'number' },
          text: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const { chatId, text } = request.body
      const result = await sendMessage({ tenantId, chatId, text })
      return result
    } catch (err) {
      request.log.error({ err }, 'Failed to send Telegram message')
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ── Messaging Health Check ───────────────────────────────────────────────
  // Returns status of all messaging workers (WhatsApp + Telegram) and DB tables.
  // Useful for uptime monitoring (UptimeRobot, Pingdom, etc.)
  fastify.get('/health/messaging', async (request, reply) => {
    try {
      const redis = getRedisConnection()
      const redisOk = redis ? (redis.status === 'ready' || redis.status === 'connect') : false

      // Check DB tables exist
      let waSessions = 0, tgSessions = 0
      try {
        const { rows: wa } = await query(`SELECT COUNT(*)::int as c FROM whatsapp_sessions`)
        waSessions = wa[0]?.c || 0
      } catch { waSessions = -1 }

      try {
        const { rows: tg } = await query(`SELECT COUNT(*)::int as c FROM telegram_sessions`)
        tgSessions = tg[0]?.c || 0
      } catch { tgSessions = -1 }

      const allOk = redisOk && waSessions >= 0 && tgSessions >= 0

      return {
        success: allOk,
        status: allOk ? 'healthy' : 'degraded',
        workers: {
          redis: redisOk ? 'connected' : 'disconnected',
          whatsapp: waSessions >= 0 ? 'ok' : 'error',
          telegram: tgSessions >= 0 ? 'ok' : 'error',
        },
        stats: {
          whatsappSessions: waSessions,
          telegramSessions: tgSessions,
        },
        timestamp: new Date().toISOString(),
      }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}
