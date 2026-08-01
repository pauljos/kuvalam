// apps/api/src/routes/settings.routes.js
import { query } from '../db/pool.js'
import { auditLog } from '../utils/audit.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { encrypt, decrypt } from '../services/crypto.service.js'
import { cached, del as cacheDel } from '../services/cache.service.js'

const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'ollama', 'groq', 'mistral', 'opencode', 'deepseek', 'kimi', 'lmstudio', 'localai', 'custom']

export default async function settingsRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }
  const ownerAdmin = {
    preHandler: [fastify.authenticate, async (req, reply) => {
      if (!['OWNER', 'ADMIN'].includes(req.user.role)) {
        return reply.status(403).send({ success: false, error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Only OWNER or ADMIN can change settings' } })
      }
    }]
  }

  // GET /tenants/:tenantId/settings
  fastify.get('/tenants/:tenantId/settings', auth, async (req, reply) => {
    try {
      const tenantId = req.params.tenantId
      
      const tenant = await cached(
        `tenant:${tenantId}:settings`,
        async () => {
          const { rows: [t] } = await query(
            'SELECT id, name, slug, plan, status, settings, llm_config, created_at FROM tenants WHERE id = $1',
            [tenantId]
          )
          return t
        },
        300 // Cache for 5 minutes
      )
      
      if (!tenant) throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)

      // Mask API keys in response — only show last 4 chars
      const safeConfig = maskLLMConfig(tenant.llm_config || {})

      return reply.send({ success: true, data: { ...tenant, llm_config: safeConfig }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // PUT /tenants/:tenantId/settings/llm  — save LLM provider config
  fastify.put('/tenants/:tenantId/settings/llm', ownerAdmin, async (req, reply) => {
    try {
      const { provider, apiKey, model, baseUrl, enabled,
              systemProvider, systemModel } = req.body

      if (provider && !SUPPORTED_PROVIDERS.includes(provider)) {
        throw new AppError('UNSUPPORTED_PROVIDER', `Provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`, 400)
      }

      // Load existing config
      const { rows: [tenant] } = await query('SELECT llm_config FROM tenants WHERE id = $1', [req.params.tenantId])
      if (!tenant) throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)

      const existing = tenant.llm_config || {}

      // Determine whether the caller is updating a provider config, or
      // only changing system-level LLM settings (systemProvider/systemModel).
      const isProviderUpdate = provider !== undefined || apiKey !== undefined ||
        model !== undefined || baseUrl !== undefined || enabled !== undefined

      let updatedConfig

      if (isProviderUpdate) {
        // Merge — support multiple providers stored per provider key.
        // API keys are encrypted at rest with AES-256-GCM via crypto.service.
        const targetProvider = provider || existing.defaultProvider || 'openai'
        const existingProvider = existing.providers?.[targetProvider] || {}
        // Preserve the previously-stored encrypted key if the caller didn't supply a new one
        const encryptedKey = apiKey ? encrypt(apiKey) : existingProvider.apiKey
        updatedConfig = {
          ...existing,
          defaultProvider: targetProvider,
          // System LLM — used for platform-level AI features (workflow gen, agent creation, etc.)
          // Falls back to defaultProvider if not explicitly set.
          ...(systemProvider !== undefined ? { systemProvider: systemProvider || null } : {}),
          ...(systemModel !== undefined ? { systemModel: systemModel || null } : {}),
          providers: {
            ...(existing.providers || {}),
            [targetProvider]: {
              apiKey: encryptedKey,
              model: model || existingProvider.model || getDefaultModel(targetProvider),
              baseUrl: baseUrl || existingProvider.baseUrl || getDefaultBaseUrl(targetProvider),
              enabled: enabled !== undefined ? enabled : (existingProvider.enabled !== undefined ? existingProvider.enabled : true),
              updatedAt: new Date().toISOString()
            }
          }
        }
      } else {
        // System-only update — don't touch provider configs, just
        // set/clear systemProvider and systemModel at the top level.
        updatedConfig = {
          ...existing,
          ...(systemProvider !== undefined ? { systemProvider: systemProvider || null } : {}),
          ...(systemModel !== undefined ? { systemModel: systemModel || null } : {})
        }
      }

      await query('UPDATE tenants SET llm_config = $1 WHERE id = $2', [updatedConfig, req.params.tenantId])

      // Invalidate cache
      await cacheDel(`tenant:${req.params.tenantId}:settings`)

      await auditLog({
        eventType: 'tenant.llm_config_updated',
        tenantId: req.params.tenantId,
        actorId: req.user.sub,
        actorType: 'USER',
        action: 'UPDATE_LLM_CONFIG',
        afterState: { provider, model, hasKey: !!apiKey }
      })

      return reply.send({ success: true, data: { llm_config: maskLLMConfig(updatedConfig) }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/settings/llm/:provider — remove a provider
  fastify.delete('/tenants/:tenantId/settings/llm/:provider', ownerAdmin, async (req, reply) => {
    try {
      const { rows: [tenant] } = await query('SELECT llm_config FROM tenants WHERE id = $1', [req.params.tenantId])
      if (!tenant) throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)

      const config = tenant.llm_config || {}
      const providers = { ...(config.providers || {}) }
      delete providers[req.params.provider]

      const updated = { ...config, providers }
      if (updated.defaultProvider === req.params.provider) {
        updated.defaultProvider = Object.keys(providers)[0] || null
      }

      await query('UPDATE tenants SET llm_config = $1 WHERE id = $2', [updated, req.params.tenantId])
      
      // Invalidate cache
      await cacheDel(`tenant:${req.params.tenantId}:settings`)
      
      await auditLog({ eventType: 'tenant.llm_provider_removed', tenantId: req.params.tenantId, actorId: req.user.sub, actorType: 'USER', action: 'REMOVE_LLM_PROVIDER', afterState: { provider: req.params.provider } })

      return reply.send({ success: true, data: { llm_config: maskLLMConfig(updated) }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/settings/llm/test — test a provider connection
  fastify.post('/tenants/:tenantId/settings/llm/test', ownerAdmin, async (req, reply) => {
    try {
      let { provider, apiKey, model } = req.body
      
      if (!apiKey || apiKey === '(saved)') {
        const { rows: [tenant] } = await query('SELECT llm_config FROM tenants WHERE id = $1', [req.params.tenantId])
        if (tenant?.llm_config?.providers?.[provider]?.apiKey) {
          apiKey = decrypt(tenant.llm_config.providers[provider].apiKey)
        }
      }

      let testResult = { success: false, message: '', latency: 0 }
      const start = Date.now()

      if (provider === 'openai' || provider === 'openrouter' || provider === 'groq' || provider === 'mistral' || provider === 'opencode' || provider === 'deepseek' || provider === 'kimi' || provider === 'lmstudio' || provider === 'localai' || provider === 'custom') {
        const baseUrl = req.body.baseUrl || getDefaultBaseUrl(provider)
        const testModel = model || getDefaultModel(provider)
        try {
          let fetchedModels = []
          try {
            const modelsRes = await fetch(`${baseUrl}/models`, { headers: { 'Authorization': `Bearer ${apiKey || 'not-required'}` } })
            if (modelsRes.ok) {
              const modelsData = await modelsRes.json()
              if (modelsData?.data && Array.isArray(modelsData.data)) fetchedModels = modelsData.data.map(m => m.id)
            }
          } catch (e) {}

          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey || 'not-required'}`,
              'Content-Type': 'application/json',
              ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://kuvalam.ai', 'X-Title': 'Kuvalam' } : {})
            },
            body: JSON.stringify({
              model: testModel,
              messages: [{ role: 'user', content: 'Reply with "OK" only.' }],
              max_tokens: 5
            })
          })
          const data = await res.json()
          if (res.ok && data.choices?.[0]) {
            testResult = { success: true, message: `Connected! Model: ${testModel}`, latency: Date.now() - start, models: fetchedModels }
          } else {
            const errorMsg = typeof data.error === 'string' ? data.error : data.error?.message || `HTTP ${res.status}`
            testResult = { success: false, message: errorMsg, latency: Date.now() - start, models: fetchedModels }
          }
        } catch (err) {
          testResult = { success: false, message: err.message, latency: Date.now() - start }
        }
      } else if (provider === 'anthropic') {
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model || 'claude-3-5-haiku-20241022', max_tokens: 5, messages: [{ role: 'user', content: 'Say OK' }] })
          })
          const data = await res.json()
          if (res.ok) {
            testResult = { success: true, message: `Connected! Model: ${model || 'claude-3-5-haiku'}`, latency: Date.now() - start }
          } else {
            testResult = { success: false, message: data.error?.message || `HTTP ${res.status}`, latency: Date.now() - start }
          }
        } catch (err) {
          testResult = { success: false, message: err.message, latency: Date.now() - start }
        }
      } else if (provider === 'ollama') {
        const baseUrl = (req.body.baseUrl || 'http://localhost:11434').replace(/\/v1\/?$/, '')
        try {
          const res = await fetch(`${baseUrl}/api/tags`)
          if (res.ok) {
            const data = await res.json()
            const ollamaModels = (data.models || []).map((m) => m.name)
            testResult = { success: true, message: `Connected! ${ollamaModels.length} models available`, latency: Date.now() - start, models: ollamaModels }
          } else {
            testResult = { success: false, message: `Ollama not reachable at ${baseUrl}`, latency: Date.now() - start }
          }
        } catch (err) {
          testResult = { success: false, message: `Cannot reach Ollama: ${err.message}`, latency: Date.now() - start }
        }
      } else {
        testResult = { success: false, message: `Testing for ${provider} not yet implemented`, latency: 0 }
      }

      return reply.send({ success: true, data: testResult, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // PUT /tenants/:tenantId/settings/general
  fastify.put('/tenants/:tenantId/settings/general', ownerAdmin, async (req, reply) => {
    try {
      const allowed = ['name', 'settings']
      const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
      if (Object.keys(updates).length === 0) throw new AppError('NO_FIELDS', 'Nothing to update', 400)

      const fields = Object.keys(updates)
      const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ')
      const { rows: [tenant] } = await query(
        `UPDATE tenants SET ${setClause} WHERE id = $1 RETURNING id, name, slug, plan, settings`,
        [req.params.tenantId, ...Object.values(updates)]
      )
      await auditLog({ eventType: 'tenant.settings_updated', tenantId: req.params.tenantId, actorId: req.user.sub, actorType: 'USER', action: 'UPDATE_SETTINGS' })
      // Invalidate caches so the frontend sees name/settings changes immediately
      await cacheDel(`tenant:${req.params.tenantId}:settings`)
      await cacheDel(`tenant:${req.params.tenantId}:info`)
      return reply.send({ success: true, data: tenant, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ──────────────────────────────────────────────
  // Prompt Templates — per-tenant archetype overrides
  // ──────────────────────────────────────────────

  // GET /tenants/:tenantId/settings/prompt-templates
  fastify.get('/tenants/:tenantId/settings/prompt-templates', auth, async (req, reply) => {
    try {
      const { rows } = await query(
        'SELECT id, archetype, label, system_prompt, is_active, updated_at FROM prompt_templates WHERE tenant_id = $1 ORDER BY archetype',
        [req.params.tenantId]
      )
      return reply.send({ success: true, data: rows, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // PUT /tenants/:tenantId/settings/prompt-templates/:archetype
  fastify.put('/tenants/:tenantId/settings/prompt-templates/:archetype', ownerAdmin, async (req, reply) => {
    try {
      const { system_prompt, is_active } = req.body
      const { tenantId, archetype } = req.params

      if (system_prompt === undefined && is_active === undefined) {
        throw new AppError('INVALID_INPUT', 'system_prompt or is_active is required', 400)
      }

      // Upsert: if the row doesn't exist for this tenant+archetype, create it
      // COALESCE in INSERT provides defaults for new rows; COALESCE in UPDATE
      // preserves existing values when a field is not provided.
      const { rows: [updated] } = await query(
        `INSERT INTO prompt_templates (tenant_id, archetype, label, system_prompt, is_active)
         VALUES ($1, $2, $2, COALESCE($3, ''), COALESCE($4, true))
         ON CONFLICT (tenant_id, archetype)
         DO UPDATE SET
           system_prompt = COALESCE($3, prompt_templates.system_prompt),
           is_active = COALESCE($4, prompt_templates.is_active),
           updated_at = NOW()
         RETURNING id, archetype, label, system_prompt, is_active, updated_at`,
        [tenantId, archetype, system_prompt || null, is_active !== undefined ? is_active : null]
      )

      await auditLog({
        eventType: 'tenant.prompt_template_updated',
        tenantId,
        actorId: req.user.sub,
        actorType: 'USER',
        action: 'UPDATE_PROMPT_TEMPLATE',
        afterState: { archetype, hasPrompt: !!system_prompt }
      })

      return reply.send({ success: true, data: updated, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/settings/prompt-templates/:archetype/reset
  fastify.post('/tenants/:tenantId/settings/prompt-templates/:archetype/reset', ownerAdmin, async (req, reply) => {
    try {
      const { tenantId, archetype } = req.params

      const { rowCount } = await query(
        'DELETE FROM prompt_templates WHERE tenant_id = $1 AND archetype = $2',
        [tenantId, archetype]
      )

      await auditLog({
        eventType: 'tenant.prompt_template_reset',
        tenantId,
        actorId: req.user.sub,
        actorType: 'USER',
        action: 'RESET_PROMPT_TEMPLATE',
        afterState: { archetype, wasDeleted: rowCount > 0 }
      })

      return reply.send({ success: true, data: { archetype, reset: rowCount > 0 }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })
}

// Mask all API keys in the config object for safe client display
function maskLLMConfig(config) {
  if (!config || !config.providers) return config
  const masked = { ...config, providers: {} }
  for (const [provider, cfg] of Object.entries(config.providers || {})) {
    masked.providers[provider] = {
      ...cfg,
      apiKey: cfg.apiKey ? `${cfg.apiKey.substring(0, 8)}${'•'.repeat(24)}` : null
    }
  }
  return masked
}

function getDefaultModel(provider) {
  const defaults = {
    openai: 'gpt-4o',
    anthropic: 'claude-3-5-sonnet-20241022',
    openrouter: 'openai/gpt-4o',
    groq: 'llama-3.3-70b-versatile',
    mistral: 'mistral-large-latest',
    ollama: 'llama3.2',
    opencode: 'deepseek-v4-pro',
    deepseek: 'deepseek-chat',
    kimi: 'moonshot-v1-auto',
    lmstudio: 'local-model',
    localai: 'gpt-3.5-turbo',
    custom: 'local-model'
  }
  return defaults[provider] || 'gpt-4o'
}

function getDefaultBaseUrl(provider) {
  const urls = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    mistral: 'https://api.mistral.ai/v1',
    ollama: 'http://localhost:11434/v1',
    opencode: 'https://opencode.ai/zen/go/v1',
    deepseek: 'https://api.deepseek.com/v1',
    kimi: 'https://api.moonshot.cn/v1',
    lmstudio: 'http://localhost:1234/v1',
    localai: 'http://localhost:8080/v1',
    custom: null
  }
  return urls[provider] || null
}

const ts = () => ({ timestamp: new Date().toISOString() })
