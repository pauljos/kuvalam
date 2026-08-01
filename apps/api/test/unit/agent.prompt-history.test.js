// Unit tests for the agent prompt-version-history decision logic
// (computePromptUndo). Guards the refiner "undo" feature so a refine/edit can
// always be rolled back to the previous system_prompt. Pure — no DB/network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'test-encryption-key-exactly-32chars!!'

const { computePromptUndo } = await import('../../src/services/agent.service.js')

const mk = (n) => Array.from({ length: n }, (_, i) => ({ prompt: `v${i}`, savedAt: `t${i}`, savedBy: 'u' }))

test('computePromptUndo: default restores the NEWEST entry (top of stack)', () => {
  const { idx, restore, remaining } = computePromptUndo(mk(3), null)
  assert.equal(idx, 2)
  assert.equal(restore.prompt, 'v2')
  assert.deepEqual(remaining.map(v => v.prompt), ['v0', 'v1'])
})

test('computePromptUndo: single entry → restores it, stack empties', () => {
  const { idx, restore, remaining } = computePromptUndo(mk(1), null)
  assert.equal(idx, 0)
  assert.equal(restore.prompt, 'v0')
  assert.deepEqual(remaining, [])
})

test('computePromptUndo: explicit index restores it and drops newer entries', () => {
  const { idx, restore, remaining } = computePromptUndo(mk(5), 2)
  assert.equal(idx, 2)
  assert.equal(restore.prompt, 'v2')
  // v3 and v4 (newer) are dropped along with the restored v2
  assert.deepEqual(remaining.map(v => v.prompt), ['v0', 'v1'])
})

test('computePromptUndo: empty history → NO_HISTORY 409', () => {
  assert.throws(() => computePromptUndo([], null), (e) => e.statusCode === 409 && e.code === 'NO_HISTORY')
})

test('computePromptUndo: null/undefined history → NO_HISTORY 409', () => {
  assert.throws(() => computePromptUndo(null, null), (e) => e.statusCode === 409)
  assert.throws(() => computePromptUndo(undefined, null), (e) => e.statusCode === 409)
})

test('computePromptUndo: out-of-range index → BAD_INDEX 400', () => {
  assert.throws(() => computePromptUndo(mk(3), 5), (e) => e.statusCode === 400 && e.code === 'BAD_INDEX')
  assert.throws(() => computePromptUndo(mk(3), -1), (e) => e.statusCode === 400)
})

test('computePromptUndo: non-integer index → BAD_INDEX 400', () => {
  assert.throws(() => computePromptUndo(mk(3), 1.5), (e) => e.statusCode === 400)
  assert.throws(() => computePromptUndo(mk(3), 'x'), (e) => e.statusCode === 400)
})
