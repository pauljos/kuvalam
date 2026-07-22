// apps/api/src/services/llm.service.js
// LLM Gateway — routes to OpenAI/Anthropic, tracks token usage
import OpenAI from 'openai'
import { query } from '../db/pool.js'
import { decrypt } from './crypto.service.js'

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
 */
export function resolveLlmConfig(llmConfig, preferredProvider) {
  if (!llmConfig) return {}
  // Structured shape → pick the requested provider, or fall back to the default
  if (llmConfig.providers) {
    const providerId =
      (preferredProvider && llmConfig.providers[preferredProvider]) ? preferredProvider :
      llmConfig.defaultProvider
    const active = (providerId && llmConfig.providers[providerId]) || {}
    return {
      apiKey: active.apiKey ? decrypt(active.apiKey) : undefined,
      baseUrl: active.baseUrl,
      model: active.model,
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
// Used by intelligent routing to pick the right model tier
export const MODEL_TIERS = {
  FAST:      { model: 'gpt-4o-mini',                  description: 'Fast, cheap — simple tasks' },
  STANDARD:  { model: 'gpt-4o',                        description: 'Balanced — most tasks' },
  ADVANCED:  { model: 'claude-3-5-sonnet-20241022',    description: 'Deep reasoning — complex tasks' },
  REASONING: { model: 'o3-mini',                       description: 'Extended reasoning — hardest tasks' },
}

// Keywords that bump to higher reasoning tiers
const REASONING_SIGNALS  = /\b(reason|infer|deduce|complex|multi.?step|analyse deeply|strategic|risk|legal|compliance|audit)\b/i
const FAST_SIGNALS       = /\b(summarise|list|format|convert|translate|extract|simple|quick)\b/i

/**
 * Auto-select the best model tier based on task complexity.
 * Returns the resolved model string.
 */
export function routeModel(goal, preferredModel, llmConfig) {
  // If the caller has explicitly set a model in llmConfig, honour it
  if (llmConfig?.model) return llmConfig.model
  if (preferredModel && !['gpt-4o', 'auto'].includes(preferredModel)) return preferredModel

  const g = goal || ''
  if (REASONING_SIGNALS.test(g)) return MODEL_TIERS.ADVANCED.model
  if (FAST_SIGNALS.test(g))      return MODEL_TIERS.FAST.model
  return MODEL_TIERS.STANDARD.model
}

function getOpenAIClient(apiKey, baseUrl) {
  // Local / self-hosted OpenAI-compatible servers (Ollama, LM Studio, LocalAI,
  // llama.cpp server, vLLM, etc.) typically don't require a bearer token, but
  // the SDK still refuses to construct without one. Supply a placeholder.
  const isLocal = baseUrl && /localhost|127\.0\.0\.1|::1|host\.docker\.internal/i.test(baseUrl)
  const key = apiKey || process.env.OPENAI_API_KEY || (isLocal ? 'not-required' : undefined)
  const options = { apiKey: key }
  if (baseUrl) options.baseURL = baseUrl
  return new OpenAI(options)
}

export async function complete({ tenantId, agentId, messages, tools = [], model = 'gpt-4o', temperature = 0.1, llmConfig = {}, provider, goal }) {
  const resolved = resolveLlmConfig(llmConfig, provider)
  const client = getOpenAIClient(resolved.apiKey, resolved.baseUrl)
  const resolvedModel = routeModel(goal, model, resolved)

  // o3/o1 reasoning models: no temperature, no tool streaming, use max_completion_tokens
  const isReasoningModel = /^o[13]/.test(resolvedModel)

  const params = {
    model: resolvedModel,
    messages,
    ...(isReasoningModel
      ? { max_completion_tokens: 8192 }
      : { temperature, max_tokens: 4096 })
  }

  if (tools.length > 0 && !isReasoningModel) {
    params.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } }
    }))
    params.tool_choice = 'auto'
  }

  try {
    const response = await client.chat.completions.create(params)
    const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

    // Log token usage for billing
    if (tenantId) {
      await query(
        `INSERT INTO audit_log (tenant_id, event_type, actor_type, actor_id, action, metadata)
         VALUES ($1, 'llm.tokens_used', 'AGENT', $2, 'LLM_COMPLETE', $3)`,
        [tenantId, agentId || 'system', JSON.stringify({
          model: resolvedModel,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens
        })]
      )
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
    if (err.status === 429) throw new Error('LLM_RATE_LIMITED')
    if (err.status === 401) throw new Error('LLM_AUTH_ERROR')
    throw err
  }
}

/**
 * Streaming variant of complete(). Calls onToken(chunk) for each text delta.
 * Accumulates tool calls from streaming deltas and returns the same shape as complete().
 */
export async function completeStream({ tenantId, agentId, messages, tools = [], model = 'gpt-4o', temperature = 0.1, llmConfig = {}, provider, onToken, goal }) {
  const resolved = resolveLlmConfig(llmConfig, provider)
  const client = getOpenAIClient(resolved.apiKey, resolved.baseUrl)
  const resolvedModel = routeModel(goal, model, resolved)
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
    params.tool_choice = 'auto'
  }

  let content = ''
  let finishReason = null
  const toolCallsMap = {} // index -> accumulated tool call
  const usage = { prompt: 0, completion: 0, total: 0 }

  try {
    const stream = await client.chat.completions.create(params)

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
      await query(
        `INSERT INTO audit_log (tenant_id, event_type, actor_type, actor_id, action, metadata)
         VALUES ($1, 'llm.tokens_used', 'AGENT', $2, 'LLM_STREAM', $3)`,
        [tenantId, agentId || 'system', JSON.stringify({
          model: resolvedModel,
          promptTokens: usage.prompt,
          completionTokens: usage.completion,
          totalTokens: usage.total
        })]
      )
    }

    return { content, toolCalls, usage, finishReason }
  } catch (err) {
    console.error('[LLM Error]', err)
    if (err.status === 429) throw new Error('LLM_RATE_LIMITED')
    if (err.status === 401) throw new Error('LLM_AUTH_ERROR')
    throw err
  }
}

export async function embed({ text, tenantId, llmConfig = {}, provider }) {
  const resolved = resolveLlmConfig(llmConfig, provider)
  const client = getOpenAIClient(resolved.apiKey, resolved.baseUrl)

  const response = await client.embeddings.create({
    model: 'text-embedding-3-large',
    input: Array.isArray(text) ? text : [text],
    dimensions: 1536
  })

  return response.data.map(d => d.embedding)
}
