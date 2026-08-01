// test/unit/tenant-supervisor.test.js
// Pure-unit tests for the supervisor's rule logic. No DB needed — we test
// the pure helpers/thresholds behavior by re-implementing the fingerprint
// heuristic and circuit-breaker math the service uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── Loop detection heuristic ───────────────────────────────────────────────
// The supervisor treats an agent as looping when the same tool with the same
// input fingerprint has been called LOOP_ACTION_THRESHOLD (8) times in a row.
const LOOP_ACTION_THRESHOLD = 8

function fingerprint(action) {
  // Match the service: tool name + normalized input
  return `${action.tool || ''}|${JSON.stringify(action.input || {})}`
}

function detectLoop(actions) {
  if (!Array.isArray(actions) || actions.length < LOOP_ACTION_THRESHOLD) return false
  const tail = actions.slice(-LOOP_ACTION_THRESHOLD)
  const first = fingerprint(tail[0])
  return tail.every(a => fingerprint(a) === first)
}

test('detectLoop: returns false for fewer than threshold actions', () => {
  const actions = Array.from({ length: 7 }, () => ({ tool: 'run_query', input: { sql: 'X' } }))
  assert.equal(detectLoop(actions), false)
})

test('detectLoop: returns true when last 8 actions have identical fingerprint', () => {
  const actions = Array.from({ length: 8 }, () => ({ tool: 'run_query', input: { sql: 'SELECT 1' } }))
  assert.equal(detectLoop(actions), true)
})

test('detectLoop: only inspects the tail — earlier variety does not matter', () => {
  const actions = [
    { tool: 'x', input: { a: 1 } },
    ...Array.from({ length: 8 }, () => ({ tool: 'run_query', input: { sql: 'DUP' } })),
  ]
  assert.equal(detectLoop(actions), true)
})

test('detectLoop: returns false when the tail varies', () => {
  const actions = [
    ...Array.from({ length: 7 }, () => ({ tool: 'run_query', input: { sql: 'DUP' } })),
    { tool: 'run_query', input: { sql: 'DIFFERENT' } },
  ]
  assert.equal(detectLoop(actions), false)
})

test('detectLoop: same tool + differing inputs is NOT a loop', () => {
  const actions = Array.from({ length: 8 }, (_, i) => ({ tool: 'run_query', input: { sql: `Q${i}` } }))
  assert.equal(detectLoop(actions), false)
})

// ─── Circuit breaker math ───────────────────────────────────────────────────
// Opens when failureRate >= 0.7 AND total >= 5.
const CIRCUIT_FAILURE_RATE = 0.7
const CIRCUIT_MIN_SAMPLE = 5

function shouldOpen({ completed_24h = 0, failed_24h = 0 } = {}) {
  const total = completed_24h + failed_24h
  if (total < CIRCUIT_MIN_SAMPLE) return false
  return failed_24h / total >= CIRCUIT_FAILURE_RATE
}

test('shouldOpen: below min sample never opens', () => {
  assert.equal(shouldOpen({ completed_24h: 0, failed_24h: 4 }), false)
})

test('shouldOpen: at or above min sample opens when failure rate ≥ 0.7', () => {
  // 4 failed / 5 total = 0.8
  assert.equal(shouldOpen({ completed_24h: 1, failed_24h: 4 }), true)
})

test('shouldOpen: below failure rate stays closed', () => {
  // 3 failed / 10 total = 0.3
  assert.equal(shouldOpen({ completed_24h: 7, failed_24h: 3 }), false)
})

test('shouldOpen: exactly at threshold opens (>= comparison)', () => {
  // 7 failed / 10 total = 0.7
  assert.equal(shouldOpen({ completed_24h: 3, failed_24h: 7 }), true)
})

test('shouldOpen: all-failed cohort opens', () => {
  assert.equal(shouldOpen({ completed_24h: 0, failed_24h: 8 }), true)
})

// ─── Wallclock ceiling ──────────────────────────────────────────────────────
// executeTask caps its wallclock at min(agent.max_wallclock_seconds*1000, env default)
function effectiveWallclockMs(agent, envDefaultMs) {
  const agentMs = agent?.max_wallclock_seconds ? agent.max_wallclock_seconds * 1000 : null
  return agentMs != null ? Math.min(agentMs, envDefaultMs) : envDefaultMs
}

test('effectiveWallclockMs: null agent setting yields env default', () => {
  assert.equal(effectiveWallclockMs({}, 480000), 480000)
})

test('effectiveWallclockMs: agent setting caps below env default', () => {
  assert.equal(effectiveWallclockMs({ max_wallclock_seconds: 60 }, 480000), 60000)
})

test('effectiveWallclockMs: env default caps above agent setting is not raised', () => {
  // Agent asks for 10 min but env allows only 5
  assert.equal(effectiveWallclockMs({ max_wallclock_seconds: 600 }, 300000), 300000)
})
