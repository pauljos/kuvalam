// apps/api/src/routes/auth.routes.js
import { registerUser, loginUser, refreshAccessToken, logoutUser } from '../services/auth.service.js'
import { errorResponse } from '../utils/errors.js'

export default async function authRoutes(fastify) {
  // POST /api/v1/auth/register
  fastify.post('/auth/register', {
    config: {
      // Strict rate limit — 5 registrations per hour per IP
      rateLimit: { max: 5, timeWindow: '1 hour' }
    },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password', 'name', 'tenantName', 'tenantSlug'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: { type: 'string', minLength: 8, maxLength: 200 },
          name: { type: 'string', minLength: 1, maxLength: 100 },
          tenantName: { type: 'string', minLength: 1, maxLength: 255 },
          tenantSlug: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9-]+$' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const result = await registerUser(request.body)
      return reply.status(201).send({ success: true, data: result, meta: ts(request) })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // POST /api/v1/auth/login
  fastify.post('/auth/login', {
    config: {
      // Strict rate limit — 10 login attempts per 15 minutes per IP to slow brute force
      rateLimit: { max: 10, timeWindow: '15 minutes' }
    },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', maxLength: 254 },
          password: { type: 'string', maxLength: 200 },
          tenantSlug: { type: 'string', maxLength: 100 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const result = await loginUser({ ...request.body, ip: request.ip })

      // Sign access token with fastify-jwt
      const accessToken = fastify.jwt.sign(
        { ...result.accessPayload },
        { expiresIn: '15m' }
      )

      const isProduction = process.env.NODE_ENV === 'production'

      // Set the access token in an httpOnly cookie
      reply.setCookie('kuvalam_token', accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'strict' : 'lax',
        path: '/',
        maxAge: 15 * 60 // 15 minutes — matches JWT expiry
      })

      // Also set the refresh token in a long-lived httpOnly cookie so the
      // browser can transparently mint a new access token when the 15-minute
      // one expires — without keeping any secrets in localStorage/JS.
      reply.setCookie('kuvalam_refresh', result.refreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'strict' : 'lax',
        path: '/api/v1/auth', // scoped to auth endpoints only
        maxAge: 30 * 24 * 60 * 60 // 30 days
      })

      return reply.send({
        success: true,
        data: {
          // accessToken is delivered ONLY via the httpOnly cookie above.
          // Body still carries the refresh token for non-browser clients
          // (CLI, scripts). Browser clients ignore it and rely on the cookie.
          refreshToken: result.refreshToken,
          user: result.user,
          tenant: result.tenant
        },
        meta: ts(request)
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // POST /api/v1/auth/refresh
  fastify.post('/auth/refresh', {
    config: {
      // Prevent refresh-token brute force / DoS
      rateLimit: { max: 30, timeWindow: '15 minutes' }
    },
    schema: {
      body: {
        type: 'object',
        // Body is optional — browsers use the kuvalam_refresh cookie instead.
        properties: { refreshToken: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    try {
      // Prefer the httpOnly cookie (browser flow); fall back to body for
      // non-browser clients that store the token themselves.
      const refreshToken = request.cookies?.kuvalam_refresh || request.body?.refreshToken
      if (!refreshToken) {
        return reply.status(401).send({
          success: false,
          error: { code: 'MISSING_REFRESH_TOKEN', message: 'Refresh token required' },
          meta: ts(request)
        })
      }

      const result = await refreshAccessToken(refreshToken)
      const accessToken = fastify.jwt.sign({ ...result.accessPayload }, { expiresIn: '15m' })

      const isProduction = process.env.NODE_ENV === 'production'
      reply.setCookie('kuvalam_token', accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'strict' : 'lax',
        path: '/',
        maxAge: 15 * 60
      })

      // Token is delivered via httpOnly cookie only
      return reply.send({ success: true, data: { expiresAt: result.expiresAt }, meta: ts(request) })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // POST /api/v1/auth/logout
  fastify.post('/auth/logout', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const refreshToken = request.cookies?.kuvalam_refresh || request.body?.refreshToken
      await logoutUser(refreshToken)
      // Clear both httpOnly cookies (must match the path each was set with)
      reply.clearCookie('kuvalam_token', { path: '/' })
      reply.clearCookie('kuvalam_refresh', { path: '/api/v1/auth' })
      return reply.send({ success: true, data: { message: 'Logged out successfully' }, meta: ts(request) })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // GET /api/v1/auth/me
  fastify.get('/auth/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    return reply.send({ success: true, data: { user: request.user }, meta: ts(request) })
  })
}

const ts = (req) => ({ requestId: req?.id, timestamp: new Date().toISOString() })
