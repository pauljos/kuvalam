// test/unit/llm.service.test.js
// Tests for model routing logic — no network calls needed

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeModel, MODEL_TIERS, resolveLlmConfig } from '../../src/services/llm.service.js'

test('routeModel: honours explicit llmConfig.model over everything', () => {
  const result = routeModel('audit the compliance report', 'gpt-4o', { model: 'gpt-4-turbo' })
  assert.equal(result, 'gpt-4-turbo')
})

test('routeModel: honours explicit preferredModel when not gpt-4o/auto', () => {
  const result = routeModel('summarise this document', 'claude-3-5-sonnet-20241022', {})
  assert.equal(result, 'claude-3-5-sonnet-20241022')
})

test('routeModel: routes compliance/legal/audit goals to ADVANCED model', () => {
  const cases = [
    'audit the Q2 financial statements',
    'compliance review of vendor contract',
    'legal risk assessment for the merger',
    'perform a multi-step analysis of the data',
  ]
  for (const goal of cases) {
    const result = routeModel(goal, 'gpt-4o', {})
    assert.equal(result, MODEL_TIERS.ADVANCED.model, `Expected ADVANCED for: "${goal}"`)
  }
})

test('routeModel: routes simple/fast goals to FAST model', () => {
  const cases = [
    'summarise this paragraph',
    'list the action items',
    'format this JSON',
    'convert the date to ISO format',
    'extract all email addresses',
  ]
  for (const goal of cases) {
    const result = routeModel(goal, 'gpt-4o', {})
    assert.equal(result, MODEL_TIERS.FAST.model, `Expected FAST for: "${goal}"`)
  }
})

test('routeModel: defaults to STANDARD for general goals', () => {
  const result = routeModel('write a follow-up email to the client', 'gpt-4o', {})
  assert.equal(result, MODEL_TIERS.STANDARD.model)
})

test('routeModel: handles empty/null goal gracefully', () => {
  assert.equal(routeModel('', 'gpt-4o', {}), MODEL_TIERS.STANDARD.model)
  assert.equal(routeModel(null, 'gpt-4o', {}), MODEL_TIERS.STANDARD.model)
  assert.equal(routeModel(undefined, 'gpt-4o', {}), MODEL_TIERS.STANDARD.model)
})

test('MODEL_TIERS has all required keys', () => {
  for (const tier of ['FAST', 'STANDARD', 'ADVANCED', 'REASONING']) {
    assert.ok(MODEL_TIERS[tier]?.model, `Missing model for tier ${tier}`)
    assert.ok(MODEL_TIERS[tier]?.description, `Missing description for tier ${tier}`)
  }
})

// ─── resolveLlmConfig — per-agent provider selection ──────────────────────────
// Uses the dev fallback CREDENTIAL_ENCRYPTION_KEY; requires no env vars.
import { encrypt } from '../../src/services/crypto.service.js'

test('resolveLlmConfig: returns empty object when llmConfig is null/undefined', () => {
  assert.deepEqual(resolveLlmConfig(null), {})
  assert.deepEqual(resolveLlmConfig(undefined), {})
})

test('resolveLlmConfig: flat legacy shape passes through with decrypted key', () => {
  const encKey = encrypt('sk-legacy-123')
  const cfg = { apiKey: encKey, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', provider: 'openai' }
  const res = resolveLlmConfig(cfg)
  assert.equal(res.apiKey, 'sk-legacy-123')
  assert.equal(res.model, 'gpt-4o')
  assert.equal(res.provider, 'openai')
})

test('resolveLlmConfig: structured shape picks defaultProvider when no preference', () => {
  const cfg = {
    defaultProvider: 'openai',
    providers: {
      openai:  { apiKey: encrypt('sk-openai'), model: 'gpt-4o' },
      ollama:  { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
    }
  }
  const res = resolveLlmConfig(cfg)
  assert.equal(res.provider, 'openai')
  assert.equal(res.apiKey, 'sk-openai')
  assert.equal(res.model, 'gpt-4o')
})

test('resolveLlmConfig: preferredProvider overrides default when configured', () => {
  const cfg = {
    defaultProvider: 'openai',
    providers: {
      openai: { apiKey: encrypt('sk-openai'), model: 'gpt-4o' },
      ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
    }
  }
  const res = resolveLlmConfig(cfg, 'ollama')
  assert.equal(res.provider, 'ollama')
  assert.equal(res.baseUrl, 'http://localhost:11434/v1')
  assert.equal(res.model, 'llama3.2')
  assert.equal(res.apiKey, undefined) // no key stored for ollama
})

test('resolveLlmConfig: preferredProvider that is not configured falls back to default', () => {
  const cfg = {
    defaultProvider: 'openai',
    providers: {
      openai: { apiKey: encrypt('sk-openai'), model: 'gpt-4o' },
    }
  }
  // Agent asks for 'ollama' but tenant hasn't configured it — fall back
  const res = resolveLlmConfig(cfg, 'ollama')
  assert.equal(res.provider, 'openai')
  assert.equal(res.apiKey, 'sk-openai')
})

test('resolveLlmConfig: local provider (no apiKey) returns undefined key + provider baseUrl', () => {
  const cfg = {
    defaultProvider: 'lmstudio',
    providers: {
      lmstudio: { baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
    }
  }
  const res = resolveLlmConfig(cfg)
  assert.equal(res.provider, 'lmstudio')
  assert.equal(res.baseUrl, 'http://localhost:1234/v1')
  assert.equal(res.apiKey, undefined)
})
