// apps/api/src/services/oauth.service.js
// Phase 3: OAuth 2.0 integration for external tool connections
// Supports: Google (Gmail, Calendar, Drive), Slack, Jira, Salesforce, Microsoft

import { query } from '../db/pool.js'
import { auditLog } from '../utils/audit.js'
import { encrypt, decrypt } from './crypto.service.js'
import { randomUUID, createHmac, timingSafeEqual } from 'crypto'

// ─── OAuth `state` param — HMAC signed to prevent tampering ────────────────
// Attackers otherwise could craft their own state and hijack the OAuth callback
// to bind an external account to a tenant they don't control.
function stateSecret() {
  const s = process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('OAUTH_STATE_SECRET (or JWT_SECRET) must be set to a 32+ char secret in production')
    }
    return 'kuvalam-dev-oauth-state-secret-min-32-chars'
  }
  return s
}

export function signOAuthState(data) {
  const payload = { ...data, nonce: randomUUID(), iat: Math.floor(Date.now() / 1000) }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', stateSecret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyOAuthState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) {
    throw new Error('Malformed OAuth state')
  }
  const [body, sig] = state.split('.')
  const expected = createHmac('sha256', stateSecret()).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('OAuth state signature invalid')
  }
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  // Reject state older than 10 minutes to prevent replay
  if (!decoded.iat || (Math.floor(Date.now() / 1000) - decoded.iat) > 600) {
    throw new Error('OAuth state expired')
  }
  return decoded
}

// ─── Provider Configurations ──────────────────────────────────────────────

const OAUTH_PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: {
      gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
      calendar: ['https://www.googleapis.com/auth/calendar'],
      drive: ['https://www.googleapis.com/auth/drive.readonly'],
    },
    profileUrl: 'https://www.googleapis.com/oauth2/v2/userinfo'
  },
  slack: {
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: {
      default: ['chat:write', 'channels:read', 'users:read']
    },
    profileUrl: 'https://slack.com/api/auth.test'
  },
  jira: {
    authUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: {
      default: ['read:jira-work', 'write:jira-work', 'read:jira-user']
    },
    audience: 'api.atlassian.com'
  },
  salesforce: {
    authUrl: 'https://login.salesforce.com/services/oauth2/authorize',
    tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    scopes: {
      default: ['api', 'refresh_token']
    }
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: {
      teams: ['https://graph.microsoft.com/Chat.ReadWrite', 'https://graph.microsoft.com/User.Read'],
      outlook: ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send'],
    }
  }
}

// ─── UI-catalog aliases → backend (provider, service) ─────────────────────
// The web catalog uses friendly per-product IDs (e.g. `gmail`, `outlook`) that
// don't map 1:1 to OAuth provider hostnames (`google`, `microsoft`). This
// lookup resolves a UI id into the concrete (provider, service) pair used to
// pick the auth URL + scope list. Keys not present here are treated as
// identity: `slack` → `slack/default`, `salesforce` → `salesforce/default`.
const PROVIDER_ALIASES = {
  gmail:   { provider: 'google',    service: 'gmail' },
  gcal:    { provider: 'google',    service: 'calendar' },
  gdrive:  { provider: 'google',    service: 'drive' },
  teams:   { provider: 'microsoft', service: 'teams' },
  outlook: { provider: 'microsoft', service: 'outlook' },
}

// Resolve a caller-supplied (provider, service) pair — which may be a UI
// catalog id like 'gmail' — into the concrete backend (provider, service)
// used to look up OAUTH_PROVIDERS and its scopes map. Also picks a sensible
// default service when the caller passes 'default' or leaves it blank.
export function resolveOAuthTarget(providerOrAlias, service) {
  const alias = PROVIDER_ALIASES[providerOrAlias]
  if (alias) return { provider: alias.provider, service: service && service !== 'default' ? service : alias.service }
  const cfg = OAUTH_PROVIDERS[providerOrAlias]
  if (!cfg) return { provider: providerOrAlias, service: service || 'default' }
  // Pick a default service key if caller didn't specify one or specified an
  // unknown key: prefer 'default', otherwise first key defined on the provider.
  let s = service && cfg.scopes[service] ? service : null
  if (!s) s = cfg.scopes.default ? 'default' : Object.keys(cfg.scopes)[0]
  return { provider: providerOrAlias, service: s }
}

// ─── Per-Tenant OAuth App Credentials (BYOC) ─────────────────────────────
// Each tenant registers their own OAuth Client ID / Secret through the UI
// popup — we never ship platform-wide OAuth secrets. Env vars are still
// honoured as a fallback (e.g. for single-tenant self-hosted deploys) but
// tenant-scoped credentials always take precedence.

export function defaultOAuthRedirectUri() {
  return `${process.env.API_URL || 'http://localhost:3001'}/api/v1/oauth/callback`
}

export async function getTenantOAuthApp(tenantId, provider) {
  // Resolve UI-catalog aliases before querying (e.g. 'gmail' → 'google', 'outlook' → 'microsoft')
  const { provider: resolvedProvider } = resolveOAuthTarget(provider)
  const { rows: [row] } = await query(
    `SELECT client_id, client_secret_enc, redirect_uri
       FROM tenant_oauth_apps
      WHERE tenant_id = $1 AND provider = $2`,
    [tenantId, resolvedProvider]
  )
  if (!row) return null
  return {
    clientId: row.client_id,
    clientSecret: decrypt(row.client_secret_enc),
    redirectUri: row.redirect_uri || defaultOAuthRedirectUri()
  }
}

// Resolve OAuth client creds for a (tenant, provider) pair.
// Precedence: tenant-scoped app  >  env vars  >  none.
async function resolveClientCredentials(tenantId, provider) {
  const tenantApp = tenantId ? await getTenantOAuthApp(tenantId, provider) : null
  if (tenantApp?.clientId && tenantApp?.clientSecret) return { ...tenantApp, source: 'tenant' }

  const envId = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_ID`]
  const envSecret = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_SECRET`]
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, redirectUri: defaultOAuthRedirectUri(), source: 'env' }
  }
  return null
}

export async function saveTenantOAuthApp({ tenantId, provider, clientId, clientSecret, redirectUri, userId }) {
  if (!tenantId || !provider) throw new Error('tenantId and provider are required')
  if (!clientId || !clientSecret) throw new Error('clientId and clientSecret are required')
  const backendProvider = resolveOAuthTarget(provider).provider
  if (!OAUTH_PROVIDERS[backendProvider]) throw new Error(`Unknown OAuth provider: ${provider}`)

  let secretEnc
  if (clientSecret === '••••••••') {
    const { rows: [row] } = await query(
      `SELECT client_secret_enc FROM tenant_oauth_apps WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, backendProvider]
    )
    if (!row) throw new Error('No existing credentials to update')
    secretEnc = row.client_secret_enc
  } else {
    secretEnc = encrypt(clientSecret)
  }

  await query(
    `INSERT INTO tenant_oauth_apps (tenant_id, provider, client_id, client_secret_enc, redirect_uri, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (tenant_id, provider) DO UPDATE
       SET client_id = EXCLUDED.client_id,
           client_secret_enc = EXCLUDED.client_secret_enc,
           redirect_uri = EXCLUDED.redirect_uri,
           updated_at = NOW()`,
    [tenantId, backendProvider, clientId, secretEnc, redirectUri || null, userId || null]
  )

  await auditLog({
    tenantId, eventType: 'oauth_app.saved', actorId: userId || 'system', actorType: 'USER',
    resourceType: 'TenantOAuthApp', resourceId: backendProvider, action: 'SAVE_OAUTH_APP',
    metadata: { provider: backendProvider }
  })

  return { provider: backendProvider, clientId, redirectUri: redirectUri || defaultOAuthRedirectUri() }
}

export async function deleteTenantOAuthApp({ tenantId, provider, userId }) {
  const backendProvider = resolveOAuthTarget(provider).provider
  const { rowCount } = await query(
    `DELETE FROM tenant_oauth_apps WHERE tenant_id = $1 AND provider = $2`,
    [tenantId, backendProvider]
  )
  if (rowCount > 0) {
    await auditLog({
      tenantId, eventType: 'oauth_app.deleted', actorId: userId || 'system', actorType: 'USER',
      resourceType: 'TenantOAuthApp', resourceId: backendProvider, action: 'DELETE_OAUTH_APP'
    })
  }
  return { deleted: rowCount > 0 }
}

export async function listTenantOAuthApps(tenantId) {
  const { rows } = await query(
    `SELECT provider, client_id, redirect_uri, updated_at
       FROM tenant_oauth_apps WHERE tenant_id = $1 ORDER BY provider`,
    [tenantId]
  )
  return rows.map(r => ({
    provider: r.provider,
    clientId: r.client_id,
    // Never return the secret; the UI only needs to know it's set.
    hasSecret: true,
    redirectUri: r.redirect_uri || defaultOAuthRedirectUri(),
    updatedAt: r.updated_at
  }))
}

// ─── Generate Authorization URL ───────────────────────────────────────────

export async function getAuthorizationUrl({ provider: providerOrAlias, service: serviceInput, tenantId, connectorId }) {
  // Resolve UI-catalog aliases (e.g. 'gmail' → { provider: 'google', service: 'gmail' })
  // BEFORE signing state, so the callback receives the concrete backend provider.
  const { provider, service } = resolveOAuthTarget(providerOrAlias, serviceInput)
  const config = OAUTH_PROVIDERS[provider]
  if (!config) throw new Error(`Unknown OAuth provider: ${providerOrAlias}`)

  const state = signOAuthState({ tenantId, connectorId, provider, service })

  // Prefer tenant-scoped OAuth app; fall back to env vars for single-tenant
  // self-hosted deployments. If neither is set, surface a specific error so
  // the UI can prompt the operator to paste their Client ID / Secret.
  const creds = await resolveClientCredentials(tenantId, provider)
  if (!creds) {
    // Optional dev-only escape hatch — set ENABLE_MOCK_OAUTH=1 to keep the
    // legacy behaviour of issuing a fake code so the flow can be exercised
    // end-to-end without real credentials.
    if (process.env.ENABLE_MOCK_OAUTH === '1' && process.env.NODE_ENV !== 'production') {
      return `${defaultOAuthRedirectUri()}?code=mock-auth-code&state=${state}`
    }
    const err = new Error(`No OAuth credentials configured for ${provider}. Add a Client ID and Secret for this tenant, then retry.`)
    err.code = 'OAUTH_APP_NOT_CONFIGURED'
    err.provider = provider
    err.redirectUri = defaultOAuthRedirectUri()
    throw err
  }

  const scopes = config.scopes[service] || config.scopes.default || []

  const params = new URLSearchParams({
    client_id: creds.clientId,
    response_type: 'code',
    redirect_uri: creds.redirectUri,
    scope: scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent'
  })

  // Jira requires audience parameter
  if (config.audience) {
    params.set('audience', config.audience)
  }

  return `${config.authUrl}?${params.toString()}`
}

// ─── Exchange Authorization Code for Tokens ───────────────────────────────

export async function exchangeCodeForTokens({ provider, code, tenantId }) {
  if (code === 'mock-auth-code') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Invalid authorization code')
    }
    return {
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      expiresIn: 3600,
      tokenType: 'Bearer',
      scope: 'mock-scope'
    }
  }

  const config = OAUTH_PROVIDERS[provider]
  if (!config) throw new Error(`Unknown OAuth provider: ${provider}`)

  const creds = await resolveClientCredentials(tenantId, provider)
  if (!creds) {
    throw new Error(`No OAuth credentials configured for ${provider}. The tenant must register a Client ID and Secret before completing the OAuth handshake.`)
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: creds.redirectUri,
    client_id: creds.clientId,
    client_secret: creds.clientSecret
  })

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Token exchange failed: ${response.status} — ${error}`)
  }

  const tokens = await response.json()
  // Preserve provider-specific extras (e.g. Salesforce returns `instance_url`
  // and `id`) so downstream API calls can be routed to the correct pod/org.
  const { access_token, refresh_token, expires_in, token_type, scope, ...extra } = tokens
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresIn: expires_in,
    tokenType: token_type,
    scope,
    extra
  }
}

// ─── Refresh Access Token ─────────────────────────────────────────────────

export async function refreshAccessToken({ provider, refreshToken, tenantId }) {
  if (refreshToken === 'mock-refresh-token') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Invalid refresh token')
    }
    return {
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      expiresIn: 3600
    }
  }

  const config = OAUTH_PROVIDERS[provider]
  if (!config) throw new Error(`Unknown OAuth provider: ${provider}`)

  const creds = await resolveClientCredentials(tenantId, provider)
  if (!creds) {
    throw new Error(`No OAuth credentials configured for ${provider}. Re-register the OAuth app for this tenant.`)
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret
  })

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }

  const tokens = await response.json()
  const { access_token, refresh_token, expires_in, ...extra } = tokens
  return {
    accessToken: access_token,
    refreshToken: refresh_token || refreshToken, // Some providers don't return a new refresh token
    expiresIn: expires_in,
    extra
  }
}

// ─── Save OAuth Tokens to Connector ───────────────────────────────────────

export async function saveOAuthTokens({ tenantId, connectorId, provider, tokens, userId }) {
  const expiresAt = new Date(Date.now() + (tokens.expiresIn || 3600) * 1000)

  // Preserve provider-specific extras (Salesforce `instance_url`, Slack team
  // metadata, etc.) that some tool handlers need to build API URLs.
  // Fields we lift to top-level (well-known, referenced by handlers):
  //   - instance_url  → Salesforce pod URL
  const extra = tokens.extra || {}
  const oauthPayload = {
    provider,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: expiresAt.toISOString(),
    scope: tokens.scope,
    ...(extra.instance_url ? { instance_url: extra.instance_url } : {}),
    // Keep the raw provider extras under `raw` for anything else that needs them.
    ...(Object.keys(extra).length ? { raw: extra } : {})
  }

  const payloadStr = JSON.stringify(oauthPayload)
  let finalId = connectorId

  if (connectorId === 'new' || !connectorId) {
    const { rows: [conn] } = await query(
      `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, status)
       VALUES ($1, $2, $3, 'OAUTH2', jsonb_build_object('oauth', $4::jsonb), 'ACTIVE')
       RETURNING id`,
      [tenantId, provider, `${provider} (OAuth)`, payloadStr]
    )
    finalId = conn.id
  } else {
    const { rowCount } = await query(
      `UPDATE tool_connections
       SET auth_type = 'OAUTH2',
           config = jsonb_set(
             COALESCE(config, '{}'::jsonb),
             '{oauth}',
             $1::jsonb
           ),
           status = 'ACTIVE',
           updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [payloadStr, connectorId, tenantId]
    )
    if (rowCount === 0) {
      const { rows: [conn] } = await query(
        `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, status)
         VALUES ($1, $2, $3, 'OAUTH2', jsonb_build_object('oauth', $4::jsonb), 'ACTIVE')
         RETURNING id`,
        [tenantId, provider, `${provider} (OAuth)`, payloadStr]
      )
      finalId = conn.id
    }
  }

  await auditLog({
    tenantId,
    eventType: 'connector.oauth_connected',
    actorId: userId || 'system',
    actorType: 'USER',
    resourceType: 'ToolConnection',
    resourceId: finalId,
    action: 'OAUTH_CONNECT',
    metadata: { provider }
  })
}

// ─── Get Valid Access Token (auto-refresh if expired) ──────────────────────

export async function getValidAccessToken(tenantId, connectorId) {
  const { rows: [conn] } = await query(
    'SELECT config FROM tool_connections WHERE id = $1 AND tenant_id = $2',
    [connectorId, tenantId]
  )

  if (!conn?.config?.oauth) {
    throw new Error('Connector does not have OAuth credentials')
  }

  const oauth = conn.config.oauth
  const expiresAt = new Date(oauth.expiresAt)

  // If token expires within 5 minutes, refresh it
  if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    const newTokens = await refreshAccessToken({
      provider: oauth.provider,
      refreshToken: oauth.refreshToken,
      tenantId
    })

    // Refresh responses often omit provider-specific extras (Salesforce won't
    // re-send instance_url) \u2014 carry them forward so downstream calls still work.
    const preservedExtra = {
      ...(oauth.raw || {}),
      ...(oauth.instance_url ? { instance_url: oauth.instance_url } : {}),
      ...(newTokens.extra || {})
    }

    await saveOAuthTokens({
      tenantId,
      connectorId,
      provider: oauth.provider,
      tokens: { ...newTokens, extra: preservedExtra }
    })

    return newTokens.accessToken
  }

  return oauth.accessToken
}

// ─── List available OAuth providers ───────────────────────────────────────

export async function listOAuthProviders(tenantId) {
  // A provider is "configured" if either a tenant-scoped OAuth app exists
  // OR the env-var fallback is set. The tenant column takes precedence.
  let tenantConfigured = new Set()
  if (tenantId) {
    const { rows } = await query(
      `SELECT provider FROM tenant_oauth_apps WHERE tenant_id = $1`,
      [tenantId]
    )
    tenantConfigured = new Set(rows.map(r => r.provider))
  }
  const envConfigured = (p) => !!process.env[`OAUTH_${p.toUpperCase()}_CLIENT_ID`]

  const backend = Object.entries(OAUTH_PROVIDERS).map(([key, config]) => ({
    id: key,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    services: Object.keys(config.scopes),
    configured: tenantConfigured.has(key) || envConfigured(key),
    tenantConfigured: tenantConfigured.has(key),
    isAlias: false,
  }))
  // Also expose the UI-catalog aliases so the web app can query a single
  // endpoint and know that e.g. `gmail` is available (backed by google).
  const aliased = Object.entries(PROVIDER_ALIASES).map(([alias, target]) => ({
    id: alias,
    name: alias.charAt(0).toUpperCase() + alias.slice(1),
    services: [target.service],
    configured: tenantConfigured.has(target.provider) || envConfigured(target.provider),
    tenantConfigured: tenantConfigured.has(target.provider),
    isAlias: true,
    provider: target.provider,
  }))
  return [...backend, ...aliased]
}
