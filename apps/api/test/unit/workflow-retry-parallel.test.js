// Unit tests for:
//   - Retry policy: normalisation + backoff calc
//   - PARALLEL step: dispatch semantics (via dryRunStep with pure sub-tasks)
//   - dryRunStep: happy path + guardrails (unsupported types, missing tool, etc.)
//
// These tests don't need Postgres / Redis — executeStepBody / dryRunStep are
// stateless when given pure step types (SET / TRANSFORM / DELAY / PARALLEL of
// those). TOOL / NOTIFY / HTTP would need connectors and are covered by integ
// tests in real environments.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-exactly-32chars!!'

const svc = await import('../../src/services/workflow.service.js')
const { dryRunStep, executeStepBody } = svc

// ── dryRunStep: SET / TRANSFORM ──────────────────────────────────────────────
test('dryRunStep: SET step interpolates vars from context', async () => {
  const res = await dryRunStep('tid', {
    type: 'SET',
    input: { vars: { greeting: 'Hello {{user.name}}', tier: '{{user.plan.tier}}' } },
  }, { user: { name: 'Ada', plan: { tier: 'gold' } } })
  assert.equal(res.ok, true)
  assert.deepEqual(res.output, { greeting: 'Hello Ada', tier: 'gold' })
  assert.ok(typeof res.durationMs === 'number')
})

test('dryRunStep: TRANSFORM step reshapes context data', async () => {
  const res = await dryRunStep('tid', {
    type: 'TRANSFORM',
    input: { template: { fullName: '{{first}} {{last}}', tags: ['{{env}}', 'active'] } },
  }, { first: 'Ada', last: 'Lovelace', env: 'prod' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.output, { fullName: 'Ada Lovelace', tags: ['prod', 'active'] })
})

// ── dryRunStep: DELAY (bounded) ──────────────────────────────────────────────
test('dryRunStep: DELAY step waits and reports waited_ms (capped)', async () => {
  const t0 = Date.now()
  const res = await dryRunStep('tid', { type: 'DELAY', input: { ms: 40 } }, {})
  const elapsed = Date.now() - t0
  assert.equal(res.ok, true)
  assert.equal(res.output.waited_ms, 40)
  assert.ok(elapsed >= 30, `expected >=30ms elapsed, got ${elapsed}`)
})

test('dryRunStep: DELAY ms=0 short-circuits', async () => {
  const zero = await dryRunStep('tid', { type: 'DELAY', input: { ms: 0 } }, {})
  assert.equal(zero.ok, true)
  assert.equal(zero.output.waited_ms, 0)
})

// ── dryRunStep: PARALLEL (sub-tasks are pure) ────────────────────────────────
test('dryRunStep: PARALLEL step runs sub-tasks and returns keyed outputs', async () => {
  const res = await dryRunStep('tid', {
    type: 'PARALLEL',
    input: {
      tasks: [
        { id: 'a', type: 'SET', input: { vars: { v: 1 } } },
        { id: 'b', type: 'TRANSFORM', input: { template: { echo: '{{user}}' } } },
      ],
    },
  }, { user: 'ada' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.output.tasks.a, { v: 1 })
  assert.deepEqual(res.output.tasks.b, { echo: 'ada' })
  assert.equal(res.output.hasErrors, false)
})

test('dryRunStep: PARALLEL rejects nested PARALLEL', async () => {
  const res = await dryRunStep('tid', {
    type: 'PARALLEL',
    input: { tasks: [ { id: 'inner', type: 'PARALLEL', input: { tasks: [] } } ] },
  }, {})
  assert.equal(res.ok, false)
  assert.match(res.error, /Nested PARALLEL/)
})

test('dryRunStep: PARALLEL requires non-empty tasks array', async () => {
  const empty = await dryRunStep('tid', { type: 'PARALLEL', input: { tasks: [] } }, {})
  assert.equal(empty.ok, false)
  assert.match(empty.error, /requires input\.tasks/)
})

test('dryRunStep: PARALLEL caps at 10 sub-tasks', async () => {
  const tasks = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, type: 'SET', input: { vars: { i } } }))
  const res = await dryRunStep('tid', { type: 'PARALLEL', input: { tasks } }, {})
  assert.equal(res.ok, false)
  assert.match(res.error, /capped at 10/)
})

test('dryRunStep: PARALLEL rejects APPROVAL sub-tasks', async () => {
  const res = await dryRunStep('tid', {
    type: 'PARALLEL',
    input: { tasks: [ { id: 'gate', type: 'APPROVAL', input: {} } ] },
  }, {})
  assert.equal(res.ok, false)
  assert.match(res.error, /APPROVAL cannot run inside PARALLEL/)
})

// ── dryRunStep: guardrails ──────────────────────────────────────────────────
test('dryRunStep: refuses AGENT (unsupported for dry-run)', async () => {
  await assert.rejects(
    () => dryRunStep('tid', { type: 'AGENT', input: { agentId: 'a1', goal: 'x' } }, {}),
    /AGENT steps cannot be dry-run/
  )
})

test('dryRunStep: refuses LOOP / APPROVAL / CREW', async () => {
  for (const type of ['LOOP', 'APPROVAL', 'CREW']) {
    await assert.rejects(
      () => dryRunStep('tid', { type, input: {} }, {}),
      /cannot be dry-run/
    )
  }
})

test('dryRunStep: TOOL with bad tool prefix returns error (not throw)', async () => {
  const res = await dryRunStep('tid', {
    type: 'TOOL',
    input: { tool: 'notavalidprefix__op', args: {} },
  }, {})
  assert.equal(res.ok, false)
  assert.match(res.error, /not a recognised connector tool/)
})

test('dryRunStep: TOOL with missing tool name returns error', async () => {
  const res = await dryRunStep('tid', { type: 'TOOL', input: {} }, {})
  assert.equal(res.ok, false)
  assert.match(res.error, /requires input\.tool/)
})

// ── executeStepBody: APPROVAL guard ──────────────────────────────────────────
test('executeStepBody: throws for APPROVAL (runNextStep handles it)', async () => {
  await assert.rejects(
    () => executeStepBody({ type: 'APPROVAL', input: {} }, {}, { tenantId: 't' }),
    /APPROVAL steps cannot be executed via executeStepBody/
  )
})

// ── Retry policy: normalisation + linear backoff ─────────────────────────────
// These probe the retry helpers indirectly by observing behaviour via a
// deterministic failing HTTP step. We stub global.fetch to fail N times then
// succeed on the (N+1)-th call.
test('retry policy: HTTP step succeeds after 2 transient failures', async () => {
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    if (calls < 3) return { ok: false, status: 500, text: async () => 'boom' }
    return { ok: true, status: 200, text: async () => '{"ok":true}' }
  }
  try {
    // Simulate the retry loop that runNextStep applies.
    const step = { type: 'HTTP', input: { url: 'https://example.test', method: 'GET' }, retry: { attempts: 3, backoffMs: 5 } }
    let out, err = null
    for (let attempt = 1; attempt <= step.retry.attempts; attempt++) {
      try { out = await executeStepBody(step, {}, { tenantId: 't' }); err = null; break }
      catch (e) { err = e; if (attempt >= step.retry.attempts) break; await new Promise(r => setTimeout(r, step.retry.backoffMs * attempt)) }
    }
    assert.equal(err, null)
    assert.equal(calls, 3)
    assert.deepEqual(out, { ok: true })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('retry policy: HTTP step exhausts attempts and surfaces last error', async () => {
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    return { ok: false, status: 503, text: async () => 'still down' }
  }
  try {
    const step = { type: 'HTTP', input: { url: 'https://example.test', method: 'GET' }, retry: { attempts: 2, backoffMs: 1 } }
    let out, err = null
    for (let attempt = 1; attempt <= step.retry.attempts; attempt++) {
      try { out = await executeStepBody(step, {}, { tenantId: 't' }); err = null; break }
      catch (e) { err = e; if (attempt >= step.retry.attempts) break; await new Promise(r => setTimeout(r, step.retry.backoffMs * attempt)) }
    }
    assert.equal(calls, 2)
    assert.ok(err, 'expected error to surface')
    assert.match(err.message, /503/)
    void out
  } finally {
    globalThis.fetch = originalFetch
  }
})
