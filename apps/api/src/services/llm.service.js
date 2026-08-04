// apps/api/src/services/llm.service.js
// LLM Gateway — routes to OpenAI/Anthropic, tracks token usage
import OpenAI from 'openai'
import { query } from '../db/pool.js'
import { decrypt } from './crypto.service.js'
import { auditLog } from '../utils/audit.js'

/**
 * Resolve a raw llm_config record (either flat `{apiKey, baseUrl, model}` or
 * the structured `{defaultProvider, providers: {...}}`) into a flat config
 * suitable for the LLM client. Decrypts the API key at the boundary.
 *
 * Exported for unit testing — most callers should use complete/completeStream/embed.
 *
 * @param {object} llmConfig            The tenant's llm_config JSON blob
 * @param {string} [preferredProvider]  Optional override — pick this provider
 *                                      from `llmConfig.providers` instead of
 *                                      the tenant's defaultProvider. Used to
 *                                      let each agent choose its own provider.
 * @param {object} [options]            Additional resolution options.
 * @param {boolean} [options.useSystem] When true, prefer llmConfig.systemProvider
 *                                      (and systemModel) over defaultProvider.
 *                                      Used for platform-level features like
 *                                      workflow generation and agent creation.
 */
export function resolveLlmConfig(llmConfig, preferredProvider, options = {}) {
  if (!llmConfig) return {}
  // Structured shape → pick the requested provider, or fall back to the default
  if (llmConfig.providers) {
    // Explicit per-agent override wins. Then system LLM (if flagged). Then default.
    let providerId
    if (preferredProvider && llmConfig.providers[preferredProvider]) {
      providerId = preferredProvider
    } else if (options.useSystem && llmConfig.systemProvider && llmConfig.providers[llmConfig.systemProvider]) {
      providerId = llmConfig.systemProvider
    } else {
      providerId = llmConfig.defaultProvider
    }
    const active = (providerId && llmConfig.providers[providerId]) || {}
    // If useSystem and systemModel is set, override the provider's default model
    const model = (options.useSystem && llmConfig.systemModel)
      ? llmConfig.systemModel
      : active.model
    return {
      apiKey: active.apiKey ? decrypt(active.apiKey) : undefined,
      baseUrl: active.baseUrl,
      model,
      provider: providerId
    }
  }
  // Flat shape (legacy or test fixtures)
  return {
    apiKey: llmConfig.apiKey ? decrypt(llmConfig.apiKey) : llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    provider: llmConfig.provider
  }
}

// ─── Model catalogue ─────────────────────────────────────────────────────────
// Used by intelligent routing to pick the right model tier. NO model name is
// hardcoded in logic — every tier can be overridden via env, and the real model
// an agent uses should come from Settings (tenant llm_config) / the agent's own
// llm_model. These tiers are only the LAST-RESORT routing fallback.
export const MODEL_TIERS = {
  FAST:      { model: process.env.LLM_TIER_FAST      || 'gpt-4o-mini',               description: 'Fast, cheap — simple tasks' },
  STANDARD:  { model: process.env.LLM_TIER_STANDARD  || 'gpt-4o',                    description: 'Balanced — most tasks' },
  ADVANCED:  { model: process.env.LLM_TIER_ADVANCED  || 'claude-3-5-sonnet-20241022', description: 'Deep reasoning — complex tasks' },
  REASONING: { model: process.env.LLM_TIER_REASONING || 'o3-mini',                   description: 'Extended reasoning — hardest tasks' },
}

// Model identifiers that mean "no explicit model chosen — route automatically".
// These are NOT real models; they're sentinels the UI/settings can pass.
const AUTO_MODEL_SENTINELS = new Set(['auto', 'default', ''])

// Keywords that bump to higher reasoning tiers
const REASONING_SIGNALS  = /\b(reason|infer|deduce|complex|multi.?step|analyse deeply|strategic|risk|legal|compliance|audit)\b/i
const FAST_SIGNALS       = /\b(summarise|list|format|convert|translate|extract|simple|quick)\b/i

/** Per-call LLM timeout (ms) — prevents hung calls from stalling tasks forever. */
const LLM_CALL_TIMEOUT_MS = parseInt(process.env.LLM_CALL_TIMEOUT_MS || '120000') // 2 min default
/** Local/Ollama models get a much longer timeout — qwen3:8b generating large HTML files needs 3-5 min. */
const LLM_CALL_TIMEOUT_LOCAL_MS = parseInt(process.env.LLM_CALL_TIMEOUT_LOCAL_MS || '300000') // 5 min for local

/** Pick the right timeout: local/Ollama models get 5min, cloud gets 2min. */
function getLlmTimeout(resolvedConfig) {
  const isLocal = resolvedConfig?.baseUrl && /localhost|127\.0\.0\.1|::1|host\.docker\.internal/i.test(resolvedConfig.baseUrl)
  return isLocal ? LLM_CALL_TIMEOUT_LOCAL_MS : LLM_CALL_TIMEOUT_MS
}

/**
 * Resolve the model to use for a call.
 * Returns the resolved model string, or null when nothing is configured
 * (caller must fail loudly rather than silently default to a hardcoded model).
 *
 * Priority (NO hardcoded model in logic):
 *   1. Explicit agent model (preferredModel) — unless it's an 'auto' sentinel.
 *   2. Tenant Settings default model (llmConfig.model, from the Settings page's
 *      defaultProvider). THIS is the universal default the user asked for.
 *   3. Complexity-tier routing (env-overridable MODEL_TIERS) — last resort only
 *      when the tenant has NOT set a default model in Settings.
 */
export function routeModel(goal, preferredModel, llmConfig) {
  // 1. Agent-level model takes priority — unless it's an 'auto'/'default' sentinel.
  if (preferredModel && !AUTO_MODEL_SENTINELS.has(String(preferredModel).toLowerCase())) return preferredModel
  // 2. Tenant Settings default model — the universal fallback.
  if (llmConfig?.model) return llmConfig.model

  // 3. Last resort: complexity-tier routing (env-overridable, not hardcoded).
  const g = goal || ''
  if (REASONING_SIGNALS.test(g)) return MODEL_TIERS.ADVANCED.model
  if (FAST_SIGNALS.test(g))      return MODEL_TIERS.FAST.model
  return MODEL_TIERS.STANDARD.model
}

/** Throw a clear, actionable error when no LLM model could be resolved. */
function assertModelResolved(resolvedModel, agentId) {
  if (!resolvedModel) {
    throw new Error(
      `No LLM model configured${agentId ? ` for agent ${agentId}` : ''}. ` +
      `Set a model in Settings (choose from your provider's available models) ` +
      `or on the agent itself. Kuvalam does not hardcode a default model.`
    )
  }
  return resolvedModel
}

function getOpenAIClient(apiKey, baseUrl) {
  // Local / self-hosted OpenAI-compatible servers (Ollama, LM Studio, LocalAI,
  // llama.cpp server, vLLM, etc.) typically don't require a bearer token, but
  // the SDK still refuses to construct without one. Supply a placeholder.
  const isLocal = baseUrl && /localhost|127\.0\.0\.1|::1|host\.docker\.internal/i.test(baseUrl)
  const key = apiKey || process.env.OPENAI_API_KEY || (isLocal ? 'not-required' : undefined)
  // Give a clear, actionable error when no API key is available.
  // The OpenAI SDK would otherwise throw a cryptic "OPENAI_API_KEY environment
  // variable is missing" — but this is often a tenant-level config issue, not
  // a missing env var. Point the user to Settings → LLM.
  if (!key) {
    throw new Error(
      'No API key configured for your LLM provider. ' +
      'Go to Settings → LLM and add an API key for your provider, ' +
      'or set OPENAI_API_KEY in your environment.'
    )
  }
  const options = { apiKey: key }
  if (baseUrl) options.baseURL = baseUrl
  return new OpenAI(options)
}

export async function complete({ tenantId, agentId, messages, tools = [], model = null, temperature = 0.1, llmConfig = {}, provider, goal, tool_choice = 'auto', useSystemLlm = false, maxTokens }) {
  const resolved = resolveLlmConfig(llmConfig, provider, { useSystem: useSystemLlm })
  const resolvedModel = assertModelResolved(routeModel(goal, model, resolved), agentId)

  const client = getOpenAIClient(resolved.apiKey, resolved.baseUrl)

  // o3/o1 reasoning models: no temperature, no tool streaming, use max_completion_tokens
  const isReasoningModel = /^o[13]/.test(resolvedModel)

  const params = {
    model: resolvedModel,
    messages,
    ...(isReasoningModel
      ? { max_completion_tokens: maxTokens || 8192 }
      : { temperature, max_tokens: maxTokens || 4096 })
  }

  if (tools.length > 0 && !isReasoningModel) {
    params.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } }
    }))
    params.tool_choice = tool_choice
  }

  // qwen3 models default to verbose "thinking" mode in Ollama, which makes
  // every response take minutes and emit huge <think> blocks. Disable thinking
  // via extra_body { think: false } for Ollama's OpenAI-compat endpoint.
  // Also inject /nothink at the start of the last user message as a belt-and-suspenders
  // approach — some Ollama versions don't honour extra_body think:false alone.
  const isLocal = resolved?.baseUrl && /localhost|127\.0\.0\.1|::1|host\.docker\.internal/i.test(resolved.baseUrl)
  const isQwen3Local = isLocal && /^qwen3[:.-]/i.test(resolvedModel)
  if (isQwen3Local) {
    params.extra_body = { ...(params.extra_body || {}), think: false }
    // Inject /nothink into the last user message for extra reliability
    const lastUserIdx = params.messages ? [...params.messages].map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0).pop() : -1
    if (lastUserIdx >= 0 && typeof params.messages[lastUserIdx].content === 'string' && !params.messages[lastUserIdx].content.startsWith('/nothink')) {
      params.messages = [...params.messages]
      params.messages[lastUserIdx] = { ...params.messages[lastUserIdx], content: '/nothink\n\n' + params.messages[lastUserIdx].content }
    }
  }

  let _rlAttempt = 0
  const _RL_BACKOFF = [5000, 15000, 30000]
  while (true) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), getLlmTimeout(resolved))
      const response = await client.chat.completions.create(params, { signal: controller.signal })
      clearTimeout(timer)
      const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

      // Log token usage for billing
      if (tenantId) {
        try {
          const _sys = messages?.find(m => m.role === 'system')
          const _lastUser = [...(messages || [])].reverse().find(m => m.role === 'user')
          await auditLog({
            eventType: 'llm.tokens_used', tenantId,
            actorId: agentId || 'system', actorType: 'AGENT',
            resourceType: 'LLM', action: 'LLM_COMPLETE',
            metadata: {
              model: resolvedModel,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
              goal: goal ? String(goal).slice(0, 200) : undefined,
              messageCount: messages?.length,
              systemPrompt: _sys?.content ? String(_sys.content).slice(0, 4000) : undefined,
              lastUserMessage: _lastUser?.content ? String(_lastUser.content).slice(0, 1500) : undefined
            }
          })
        } catch { /* audit failure must not break LLM call */ }
      }

      return {
        content: response.choices[0]?.message?.content || '',
        toolCalls: response.choices[0]?.message?.tool_calls || [],
        usage: {
          prompt: usage.prompt_tokens,
          completion: usage.completion_tokens,
          total: usage.total_tokens
        },
        finishReason: response.choices[0]?.finish_reason
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'ETIMEDOUT') {
        throw new Error(`LLM call timed out after ${LLM_CALL_TIMEOUT_MS / 1000}s. The model may be overloaded or unresponsive.`)
      }
      if (err.status === 429 && _rlAttempt < _RL_BACKOFF.length) {
        const delay = _RL_BACKOFF[_rlAttempt++]
        console.warn(`[LLM] Rate limited (429) — retrying in ${delay / 1000}s (attempt ${_rlAttempt}/${_RL_BACKOFF.length})`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err.status === 429) throw new Error('LLM_RATE_LIMITED')
      if (err.status === 401) throw new Error('LLM_AUTH_ERROR')
      throw err
    }
  }
}

/**
 * Streaming variant of complete(). Calls onToken(chunk) for each text delta.
 * Accumulates tool calls from streaming deltas and returns the same shape as complete().
 */
export async function completeStream({ tenantId, agentId, messages, tools = [], model = null, temperature = 0.1, llmConfig = {}, provider, onToken, goal, tool_choice = 'auto' }) {
  const resolved = resolveLlmConfig(llmConfig, provider)
  const resolvedModel = assertModelResolved(routeModel(goal, model, resolved), agentId)

  const client = getOpenAIClient(resolved.apiKey, resolved.baseUrl)
  const isReasoningModel = /^o[13]/.test(resolvedModel)

  const params = {
    model: resolvedModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(isReasoningModel
      ? { max_completion_tokens: 8192 }
      : { temperature, max_tokens: 4096 })
  }

  if (tools.length > 0 && !isReasoningModel) {
    params.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } }
    }))
    params.tool_choice = tool_choice
  }

  // Disable qwen3 verbose "thinking" mode for local Ollama (see complete()).
  const isLocal = resolved?.baseUrl && /localhost|127\.0\.0\.1|::1|host\.docker\.internal/i.test(resolved.baseUrl)
  const isQwen3Local = isLocal && /^qwen3[:.-]/i.test(resolvedModel)
  if (isQwen3Local) {
    params.extra_body = { ...(params.extra_body || {}), think: false }
    // Inject /nothink into the last user message for extra reliability
    const lastUserIdx = params.messages ? [...params.messages].map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0).pop() : -1
    if (lastUserIdx >= 0 && typeof params.messages[lastUserIdx].content === 'string' && !params.messages[lastUserIdx].content.startsWith('/nothink')) {
      params.messages = [...params.messages]
      params.messages[lastUserIdx] = { ...params.messages[lastUserIdx], content: '/nothink\n\n' + params.messages[lastUserIdx].content }
    }
  }

  let _rlAttempt = 0
  const _RL_BACKOFF = [5000, 15000, 30000]
  while (true) {
    let content = ''
    let finishReason = null
    const toolCallsMap = {} // index -> accumulated tool call
    const usage = { prompt: 0, completion: 0, total: 0 }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), getLlmTimeout(resolved))
      const stream = await client.chat.completions.create(params, { signal: controller.signal })

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        finishReason = chunk.choices[0]?.finish_reason || finishReason

        if (delta?.content) {
          content += delta.content
          if (onToken) onToken(delta.content)
        }

        // Accumulate streaming tool call fragments
        if (delta?.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } }
            }
            if (tcDelta.id) toolCallsMap[idx].id = tcDelta.id
            if (tcDelta.function?.name) toolCallsMap[idx].function.name += tcDelta.function.name
            if (tcDelta.function?.arguments) toolCallsMap[idx].function.arguments += tcDelta.function.arguments
          }
        }

        // Usage comes in the final chunk when stream_options.include_usage is set
        if (chunk.usage) {
          usage.prompt = chunk.usage.prompt_tokens || 0
          usage.completion = chunk.usage.completion_tokens || 0
          usage.total = chunk.usage.total_tokens || 0
        }
      }

      const toolCalls = Object.values(toolCallsMap)

      if (tenantId) {
        try {
          const _sys = messages?.find(m => m.role === 'system')
          const _lastUser = [...(messages || [])].reverse().find(m => m.role === 'user')
          await auditLog({
            eventType: 'llm.tokens_used', tenantId,
            actorId: agentId || 'system', actorType: 'AGENT',
            resourceType: 'LLM', action: 'LLM_STREAM',
            metadata: {
              model: resolvedModel,
              promptTokens: usage.prompt,
              completionTokens: usage.completion,
              totalTokens: usage.total,
              goal: goal ? String(goal).slice(0, 200) : undefined,
              messageCount: messages?.length,
              systemPrompt: _sys?.content ? String(_sys.content).slice(0, 4000) : undefined,
              lastUserMessage: _lastUser?.content ? String(_lastUser.content).slice(0, 1500) : undefined
            }
          })
        } catch { /* audit failure must not break LLM call */ }
      }

      clearTimeout(timer)
      return { content, toolCalls, usage, finishReason }
    } catch (err) {
      console.error('[LLM Error]', err)
      if (err.name === 'AbortError' || err.code === 'ETIMEDOUT') {
        throw new Error(`LLM streaming call timed out after ${LLM_CALL_TIMEOUT_MS / 1000}s. The model may be overloaded or unresponsive.`)
      }
      if (err.status === 429 && _rlAttempt < _RL_BACKOFF.length) {
        const delay = _RL_BACKOFF[_rlAttempt++]
        console.warn(`[LLM Stream] Rate limited (429) — retrying in ${delay / 1000}s (attempt ${_rlAttempt}/${_RL_BACKOFF.length})`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err.status === 429) throw new Error('LLM_RATE_LIMITED')
      if (err.status === 401) throw new Error('LLM_AUTH_ERROR')
      throw err
    }
  }
}

// ─── Tool-capability probe ─────────────────────────────────────────────────
// In-memory cache of model → tool-capability results. One cheap API call per
// unknown model, cached for the server lifetime. Avoids wasting a full task
// execution on models (e.g. qwen3:4b) that claim "tools" in metadata but
// don't actually return function calls at runtime.
//
// Industry standard: no provider exposes reliable capability metadata via API.
// Ollama's /api/show "capabilities" field is self-reported and often wrong.
// OpenAI's /v1/models returns no capability info. The only reliable way to
// know is to ask the model to use a tool and see if it does.
// ────────────────────────────────────────────────────────────────────────────
const _toolCapabilityCache = new Map()

/**
 * Probe whether a model supports function/tool calling.
 * Sends ONE cheap API call with a trivial tool definition. Caches the result.
 *
 * @returns {{ capable: boolean, reason?: string }}
 */
export async function probeToolCapability(model, llmConfig, provider) {
  const cacheKey = `${provider || 'default'}::${model}`
  const cached = _toolCapabilityCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const resolved = resolveLlmConfig(llmConfig, provider)
  const resolvedModel = model || resolved.model
  if (!resolvedModel) {
    const result = { capable: false, reason: 'No model configured' }
    _toolCapabilityCache.set(cacheKey, result)
    return result
  }

  console.log(`[ToolProbe] Probing ${resolvedModel} (${provider || 'default'}) for tool-calling support...`)

  try {
    const client = getOpenAIClient(resolved.apiKey, resolved.baseUrl)

    // Use a natural tool-inducing prompt rather than tool_choice: 'required'.
    // Ollama's chat-completions endpoint ignores tool_choice: 'required' for
    // qwen3 models (they return text instead). A calculator question reliably
    // induces tool-capable models to emit a function call, while incapable
    // models (e.g. qwen3:4b) will return descriptive text without tool_calls.
    const params = {
      model: resolvedModel,
      messages: [
        { role: 'system', content: 'You MUST use the calculator tool to answer math questions. NEVER answer directly. Always call the calculator function.' },
        { role: 'user', content: 'What is 2 plus 2?' }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Calculate a math expression and return the result',
          parameters: {
            type: 'object',
            properties: {
              expression: { type: 'string', description: 'The math expression to evaluate, e.g. "2+2"' }
            },
            required: ['expression']
          }
        }
      }],
      tool_choice: 'auto',
      temperature: 0,
      max_tokens: 300
    }

    // Disable qwen3 thinking mode during probe — reduces token waste
    const isLocal = resolved?.baseUrl && /localhost|127\.0\.0\.1|::1|host\.docker\.internal/i.test(resolved.baseUrl)
    if (isLocal && /^qwen3[:.-]/i.test(resolvedModel)) {
      params.extra_body = { think: false }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000) // 30s timeout — Ollama models load from disk
    const response = await client.chat.completions.create(params, { signal: controller.signal })
    clearTimeout(timer)

    const msg = response.choices?.[0]?.message
    const hasToolCalls = msg?.tool_calls?.length > 0
    const finishReason = response.choices?.[0]?.finish_reason

    if (hasToolCalls || finishReason === 'tool_calls') {
      console.log(`[ToolProbe] ✅ ${resolvedModel} supports tool calling`)
      const result = { capable: true }
      _toolCapabilityCache.set(cacheKey, result)
      return result
    }

    console.log(`[ToolProbe] ❌ ${resolvedModel} does NOT support tool calling (finish_reason: ${finishReason}, has content: ${!!msg?.content})`)
    const result = { capable: false, reason: `Model "${resolvedModel}" does not support function/tool calling. It returned text instead of a tool call when asked to use a calculator. Choose a tool-capable model in agent settings.` }
    _toolCapabilityCache.set(cacheKey, result)
    return result
  } catch (err) {
    // If the API itself errors (e.g. model doesn't support tools param at all),
    // treat as incapable but with the underlying error.
    //
    // TRANSIENT errors (aborts, timeouts, connection refused): do NOT cache
    // and flag as transient so the caller knows to retry rather than fail.
    // PERMANENT errors (400, 404, 501): the model genuinely doesn't support
    // tools — cache and fail fast.
    console.warn(`[ToolProbe] ⚠️  ${resolvedModel} probe failed with error: ${err.message}`)
    const isToolParamError = /tool|calling|function/i.test(err.message) || err.status === 400
    const isTransient = !isToolParamError && err.status !== 501 && err.status !== 404
    const reason = isToolParamError
      ? `Model "${resolvedModel}" does not support function/tool calling (API rejected the tools parameter). Choose a different model.`
      : isTransient
        ? `Could not verify tool support for "${resolvedModel}": ${err.message}. (Transient error — will retry on next task.)`
        : `Could not verify tool support for "${resolvedModel}": ${err.message}. Treating as incapable to be safe.`
    const result = { capable: false, reason, transient: isTransient }
    // Only cache definite results, not transient errors
    if (!isTransient) {
      _toolCapabilityCache.set(cacheKey, result)
    }
    return result
  }
}

export async function embed({ text, tenantId, llmConfig = {}, provider }) {
  const inputArray = Array.isArray(text) ? text : [text]

  // ── Try tenant's configured provider first ──────────────────────────
  try {
    const resolved = resolveLlmConfig(llmConfig, provider)
    if (resolved.apiKey && resolved.baseUrl) {
      const client = getOpenAIClient(resolved.apiKey, resolved.baseUrl)
      const response = await client.embeddings.create({
        model: 'text-embedding-3-large',
        input: inputArray,
        dimensions: 1536
      })
      return response.data.map(d => d.embedding)
    }
  } catch (err) {
    console.warn(`[Embed] Configured provider failed: ${err.message}. Falling back to Ollama local embedding.`)
  }

  // ── Fallback: Ollama local embedding (nomic-embed-text) ────────────
  try {
    const resp = await fetch('http://localhost:11434/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: inputArray })
    })
    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Ollama embed returned ${resp.status}: ${body.slice(0, 200)}`)
    }
    const data = await resp.json()
    if (!data.embeddings || data.embeddings.length === 0) {
      throw new Error('Ollama returned empty embeddings array')
    }
    return data.embeddings
  } catch (err) {
    console.error(`[Embed] Ollama fallback also failed: ${err.message}`)
    throw err
  }
}
