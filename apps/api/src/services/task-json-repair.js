// apps/api/src/services/task-json-repair.js
// JSON repair utilities for LLM output parsing.
// Extracted from task.service.js to reduce module size.
import { createHmac, createHash } from 'crypto'

/**
 * Create a short deterministic hash from multiple parts.
 * Used for deduplication and cache keys.
 */
export function hashKey(...parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

/**
 * Remove model chain-of-thought blocks from LLM output. Many reasoning models
 * (e.g. qwen3 on Groq/Ollama) prepend a verbose <think>…</think> block to every
 * response, which would otherwise inflate token counts and pollute prompts.
 * Handles closed blocks and dangling open <think> (truncated) blocks.
 */
export function stripThinkBlocks(str) {
  if (!str) return str
  let out = String(str).replace(/<think>[\s\S]*?<\/think>/gi, '')
  // Dangling unclosed <think> (truncated mid-thought) — drop from the tag onward.
  if (/<think>/i.test(out)) out = out.replace(/<think>[\s\S]*$/i, '')
  return out.trim()
}

/**
 * Safely parse a JSON string with multiple repair strategies.
 *
 * Stage 1: Direct JSON.parse (fast path).
 * Stage 2: Extract JSON from markdown ```json fences.
 * Stage 3: Escape literal newlines inside string values.
 * Stage 4: Close open brackets/quotes if the LLM truncated the output.
 * Stage 5: Regex extraction for simple command/script patterns.
 *
 * Returns the parsed object on success, null if all stages fail.
 * A null return signals the LLM output was not valid JSON; callers MUST
 * handle this by retrying or failing.
 */
export function safeParseJSON(str) {
  if (!str) return {}
  let cleanStr = str.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || str.trim()
  try {
    return JSON.parse(cleanStr)
  } catch (err) {
    console.error('[JSON Parse Error] Raw string:', JSON.stringify(str))
    console.error('[JSON Parse Error] Message:', err.message)

    let repaired = str.trim()

    // 1. Try to extract JSON from markdown code blocks
    const jsonBlockMatch = repaired.match(/```json\s*([\s\S]*?)\s*```/)
    if (jsonBlockMatch) {
      try {
        return JSON.parse(jsonBlockMatch[1].trim())
      } catch (e) {}
    }

    // 2. Escape literal newlines within string values
    let inString = false
    let escapeActive = false
    let chars = []
    for (let i = 0; i < repaired.length; i++) {
      const char = repaired[i]
      if (char === '"' && !escapeActive) {
        inString = !inString
        chars.push(char)
      } else if (inString) {
        if (char === '\\') {
          escapeActive = !escapeActive
          chars.push(char)
        } else {
          escapeActive = false
          if (char === '\n') {
            chars.push('\\', 'n')
          } else if (char === '\r') {
            chars.push('\\', 'r')
          } else {
            chars.push(char)
          }
        }
      } else {
        chars.push(char)
      }
    }
    repaired = chars.join('')

    try {
      return JSON.parse(repaired)
    } catch (e) {
      // 3. Close open brackets/quotes if truncated
      try {
        let openBraces = 0
        let openBrackets = 0
        let inStr = false
        let esc = false
        for (let i = 0; i < repaired.length; i++) {
          const c = repaired[i]
          if (c === '"' && !esc) {
            inStr = !inStr
          } else if (inStr) {
            if (c === '\\') esc = !esc
            else esc = false
          } else {
            if (c === '{') openBraces++
            if (c === '}') openBraces--
            if (c === '[') openBrackets++
            if (c === ']') openBrackets--
          }
        }

        let suffix = ''
        if (inStr) suffix += '"'
        while (openBraces > 0) {
          suffix += '}'
          openBraces--
        }
        while (openBrackets > 0) {
          suffix += ']'
          openBrackets--
        }

        if (suffix) {
          try {
            return JSON.parse(repaired + suffix)
          } catch (e2) {}
        }
      } catch (e_trunc) {}
    }

    // 4. Try regex extraction for single string arguments (e.g. command or script)
    const commandMatch = str.match(/^\{\s*"command"\s*:\s*"([\s\S]*)"\s*\}$/)
    if (commandMatch) {
      return { command: commandMatch[1] }
    }
    const commandExtract = str.match(/"command"\s*:\s*"([\s\S]*?)"(?=\s*\}|\s*,)/)
    if (commandExtract) {
      return { command: commandExtract[1] }
    }

    // Give up — return null so callers can distinguish "could not parse"
    // from "parsed an empty object". A null signals the LLM output was
    // not valid JSON; callers MUST handle this by retrying or failing.
    return null
  }
}

/**
 * Try to parse a model's text response as a tool call JSON object.
 * Returns a synthetic tool_call structure matching the OpenAI format if
 * successful, or null if the text doesn't look like a tool call.
 *
 * Used as a fallback for models (especially Ollama) that don't support
 * native function calling but CAN output JSON when prompted.
 */
export function tryParseToolCallFromText(text, toolDefinitions) {
  if (!text) return null
  const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!cleanText) return null

  // First try the whole text as pure JSON (fast path)
  let parsed = safeParseJSON(cleanText)
  if (parsed && typeof parsed === 'object') {
    const name = parsed.name || parsed.tool || parsed.function
    if (name && typeof name === 'string') {
      const def = toolDefinitions.find(d => d.name === name)
      if (def) {
        const args = parsed.arguments || parsed.args || parsed.parameters || parsed.input || {}
        const argsStr = typeof args === 'string' ? args : JSON.stringify(args)
        return { id: `synth_${Date.now()}`, type: 'function', function: { name, arguments: argsStr } }
      }
    }
  }

  // ── Fallback: extract JSON tool-call objects from prose ───────────────
  // Small models often output: "some reasoning text...{"name":"tool","arguments":{}}"
  // Find all JSON objects containing "name" and "arguments" keys.
  const jsonCandidates = []
  let depth = 0, start = -1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i
      depth++
    } else if (text[i] === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        jsonCandidates.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }

  for (const cand of jsonCandidates) {
    const p = safeParseJSON(cand)
    if (!p || typeof p !== 'object') continue
    const name = p.name || p.tool || p.function
    if (!name || typeof name !== 'string') continue
    const def = toolDefinitions.find(d => d.name === name)
    if (!def) continue
    const args = p.arguments || p.args || p.parameters || p.input || {}
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args)
    return { id: `synth_${Date.now()}`, type: 'function', function: { name, arguments: argsStr } }
  }

  return null
}

/**
 * Sign a short-lived scoped bearer token for outbound A2A delegation calls.
 * The token is a compact HMAC-signed JSON (NOT the master JWT_SECRET). External
 * agents can only replay it for ~5 minutes and it never grants access to Kuvalam.
 */
export function signA2ACallToken({ agentId, taskId, agentUrl }) {
  const secret = process.env.A2A_CALL_SECRET || process.env.JWT_SECRET || 'kuvalam-a2a-dev'
  const payload = {
    iss: 'kuvalam',
    sub: `agent:${agentId}`,
    taskId,
    aud: (() => { try { return new URL(agentUrl).host } catch { return null } })(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300 // 5 min
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}
