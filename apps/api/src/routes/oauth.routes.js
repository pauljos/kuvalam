// apps/api/src/routes/oauth.routes.js
// Phase 3: OAuth 2.0 Callback, Status, and per-tenant OAuth-app credential endpoints
import {
  exchangeCodeForTokens,
  saveOAuthTokens,
  listOAuthProviders,
  verifyOAuthState,
  listTenantOAuthApps,
  saveTenantOAuthApp,
  deleteTenantOAuthApp,
  getTenantOAuthApp,
  defaultOAuthRedirectUri
} from '../services/oauth.service.js'
import { AppError } from '../utils/errors.js'

export default async function oauthRoutes(fastify) {
  // Callback endpoint for all OAuth providers
  fastify.get('/oauth/callback', async (req, reply) => {
    const { code, state, error } = req.query

    if (error) {
      req.log.error(`OAuth authorization error callback: ${error}`)
      // Redirect back to frontend settings/connectors page with error
      return reply.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard/connectors?error=${encodeURIComponent(error)}`)
    }

    if (!code || !state) {
      throw new AppError('BAD_REQUEST', 'Missing authorization code or state', 400)
    }

    try {
      // Verify signed state parameter (HMAC-authenticated to prevent tampering/replay)
      const decodedState = verifyOAuthState(state)
      const { tenantId, connectorId, provider } = decodedState

      req.log.info(`Exchanging code for provider: ${provider}, tenant: ${tenantId}`)

      const tokens = await exchangeCodeForTokens({ provider, code, tenantId })
      await saveOAuthTokens({
        tenantId,
        connectorId,
        provider,
        tokens,
        userId: 'oauth-system'
      })

      // Redirect back to connectors dashboard with success flag
      return reply.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard/connectors?success=true&connectorId=${connectorId}`)
    } catch (err) {
      req.log.error('OAuth token exchange failed:', err)
      return reply.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard/connectors?error=${encodeURIComponent(err.message)}`)
    }
  })

  // List available OAuth providers and configuration state (per-tenant)
  fastify.get('/tenants/:tenantId/oauth/providers', { preHandler: [fastify.authenticate] }, async (req) => {
    return { data: { providers: await listOAuthProviders(req.params.tenantId), defaultRedirectUri: defaultOAuthRedirectUri() } }
  })

  // List OAuth apps this tenant has registered (client_id is returned; secret is never returned)
  fastify.get('/tenants/:tenantId/oauth/apps', { preHandler: [fastify.authenticate] }, async (req) => {
    return { data: { apps: await listTenantOAuthApps(req.params.tenantId), defaultRedirectUri: defaultOAuthRedirectUri() } }
  })

  // Fetch a single tenant OAuth app (metadata only, no secret)
  fastify.get('/tenants/:tenantId/oauth/apps/:provider', { preHandler: [fastify.authenticate] }, async (req) => {
    const app = await getTenantOAuthApp(req.params.tenantId, req.params.provider)
    if (!app) return { data: { configured: false, provider: req.params.provider, defaultRedirectUri: defaultOAuthRedirectUri() } }
    return {
      data: {
        configured: true,
        provider: req.params.provider,
        clientId: app.clientId,
        redirectUri: app.redirectUri,
        defaultRedirectUri: defaultOAuthRedirectUri()
      }
    }
  })

  // Create or update a tenant OAuth app (BYOC)
  fastify.put('/tenants/:tenantId/oauth/apps/:provider', { preHandler: [fastify.authenticate] }, async (req) => {
    const { clientId, clientSecret, redirectUri } = req.body || {}
    if (!clientId || !clientSecret) {
      throw new AppError('MISSING_FIELDS', 'clientId and clientSecret are required', 400)
    }
    try {
      const saved = await saveTenantOAuthApp({
        tenantId: req.params.tenantId,
        provider: req.params.provider,
        clientId,
        clientSecret,
        redirectUri,
        userId: req.user?.id
      })
      return { data: { ...saved, configured: true } }
    } catch (err) {
      throw new AppError('OAUTH_APP_SAVE_FAILED', err.message || 'Failed to save OAuth app', 400)
    }
  })

  // Delete a tenant OAuth app
  fastify.delete('/tenants/:tenantId/oauth/apps/:provider', { preHandler: [fastify.authenticate] }, async (req) => {
    const res = await deleteTenantOAuthApp({
      tenantId: req.params.tenantId,
      provider: req.params.provider,
      userId: req.user?.id
    })
    return { data: res }
  })
}
