// Unit tests for the new workflow step types (SET, DELAY, TRANSFORM).
// These three are I/O-free so we can exercise them without hitting the DB
// or a real agent. TOOL, LOOP, NOTIFY talk to the connector layer / agents
// and are covered by integration tests in a real environment.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-exactly-32chars!!'

const { interpolateTemplate, interpolateDeep } = await import('../../src/services/workflow.service.js')

// The engine's SET step body is:
//   output = interpolateDeep(step.input?.vars || {}, context)
// so we verify that helper directly with SET-shaped inputs.
test('SET step: interpolateDeep resolves {{}} inside a vars map', () => {
  const ctx = { lookup: { name: 'Ada', plan: { tier: 'gold' } } }
  const vars = { customerName: '{{lookup.name}}', tier: '{{lookup.plan.tier}}', hardcoded: 'yes' }
  const out = interpolateDeep(vars, ctx)
  assert.deepEqual(out, { customerName: 'Ada', tier: 'gold', hardcoded: 'yes' })
})

// TRANSFORM step body:
//   output = interpolateDeep(step.input?.template ?? {}, context)
test('TRANSFORM step: walks nested arrays and objects', () => {
  const ctx = { user: { id: 42, name: 'Ada' }, tier: 'vip' }
  const template = {
    person: { id: '{{user.id}}', display: 'Name: {{user.name}}' },
    tags: ['{{tier}}', 'active'],
    literal: 7,
  }
  const out = interpolateDeep(template, ctx)
  assert.deepEqual(out, {
    person: { id: '42', display: 'Name: Ada' },
    tags: ['vip', 'active'],
    literal: 7,
  })
})

test('TRANSFORM step: unknown vars are left as tokens', () => {
  const out = interpolateDeep({ name: '{{missing}}' }, {})
  assert.equal(out.name, '{{missing}}')
})

// interpolateTemplate is what all step-bodies use for goal / url / channel /
// message strings — verify a couple of realistic NOTIFY / LOOP shapes.
test('NOTIFY-style message string: interpolates from prior step output', () => {
  const ctx = { research: { summary: 'The sky is blue.' } }
  const out = interpolateTemplate('📢 Result: {{research.summary}}', ctx)
  assert.equal(out, '📢 Result: The sky is blue.')
})

test('LOOP goalTemplate: item and index vars are dot-path accessible', () => {
  const iterCtx = { item: { title: 'Ticket A', id: 7 }, index: 0 }
  const out = interpolateTemplate('Handle #{{index}} — {{item.title}} (id {{item.id}})', iterCtx)
  assert.equal(out, 'Handle #0 — Ticket A (id 7)')
})

// DELAY doesn't need a helper — we just make sure the workflow module exports
// the interpolation helpers the engine relies on for the other new types.
test('workflow module still exports interpolation helpers', () => {
  assert.equal(typeof interpolateTemplate, 'function')
  assert.equal(typeof interpolateDeep, 'function')
})
