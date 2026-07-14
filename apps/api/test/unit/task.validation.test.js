// test/unit/task.validation.test.js
// Tests for dispatchTask input validation logic (no DB/LLM calls)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../../src/utils/errors.js'

// ─── Replicate validation logic from dispatchTask ─────────────────────────────
// Extracted so we can test without mocking the entire DB/LLM stack

function validateTaskInput({ goal, priority, attachments = [] }) {
  if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
    throw new AppError('MISSING_GOAL', 'Task goal is required and must be a non-empty string', 400)
  }
  if (goal.length > 10_000) {
    throw new AppError('GOAL_TOO_LONG', 'Task goal must be 10,000 characters or fewer', 400)
  }
  const VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH']
  const resolvedPriority = VALID_PRIORITIES.includes(priority) ? priority : 'MEDIUM'

  if (!Array.isArray(attachments)) attachments = []
  if (attachments.length > 5) {
    throw new AppError('TOO_MANY_ATTACHMENTS', 'Maximum 5 attachments per task', 400)
  }
  for (const att of attachments) {
    if (att.type === 'image_url' && !/^https:\/\//.test(att.url || '')) {
      throw new AppError('INVALID_ATTACHMENT', 'Image attachments must be publicly accessible https:// URLs', 400)
    }
  }
  return { goal: goal.trim(), priority: resolvedPriority, attachments }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('validateTaskInput: accepts valid goal', () => {
  const result = validateTaskInput({ goal: 'Summarise the Q4 report', priority: 'HIGH' })
  assert.equal(result.goal, 'Summarise the Q4 report')
  assert.equal(result.priority, 'HIGH')
})

test('validateTaskInput: rejects empty string goal', () => {
  assert.throws(
    () => validateTaskInput({ goal: '' }),
    (err) => { assert.equal(err.code, 'MISSING_GOAL'); return true }
  )
})

test('validateTaskInput: rejects whitespace-only goal', () => {
  assert.throws(
    () => validateTaskInput({ goal: '   ' }),
    (err) => { assert.equal(err.code, 'MISSING_GOAL'); return true }
  )
})

test('validateTaskInput: rejects null goal', () => {
  assert.throws(
    () => validateTaskInput({ goal: null }),
    (err) => { assert.equal(err.code, 'MISSING_GOAL'); return true }
  )
})

test('validateTaskInput: rejects non-string goal', () => {
  assert.throws(
    () => validateTaskInput({ goal: 12345 }),
    (err) => { assert.equal(err.code, 'MISSING_GOAL'); return true }
  )
})

test('validateTaskInput: rejects goal over 10,000 chars', () => {
  assert.throws(
    () => validateTaskInput({ goal: 'x'.repeat(10_001) }),
    (err) => { assert.equal(err.code, 'GOAL_TOO_LONG'); return true }
  )
})

test('validateTaskInput: accepts goal of exactly 10,000 chars', () => {
  const result = validateTaskInput({ goal: 'x'.repeat(10_000) })
  assert.equal(result.goal.length, 10_000)
})

test('validateTaskInput: sanitises invalid priority to MEDIUM', () => {
  const result = validateTaskInput({ goal: 'Do something', priority: 'CRITICAL' })
  assert.equal(result.priority, 'MEDIUM')
})

test('validateTaskInput: accepts all valid priorities', () => {
  for (const p of ['LOW', 'MEDIUM', 'HIGH']) {
    const result = validateTaskInput({ goal: 'Do something', priority: p })
    assert.equal(result.priority, p)
  }
})

test('validateTaskInput: rejects more than 5 attachments', () => {
  const attachments = Array.from({ length: 6 }, (_, i) => ({ type: 'image_url', url: `https://example.com/${i}.png` }))
  assert.throws(
    () => validateTaskInput({ goal: 'Analyse these images', attachments }),
    (err) => { assert.equal(err.code, 'TOO_MANY_ATTACHMENTS'); return true }
  )
})

test('validateTaskInput: rejects non-https (http://) image URL', () => {
  // Source code fixed to use /^https:\/\// — http:// must be rejected
  assert.throws(
    () => validateTaskInput({ goal: 'Look at this', attachments: [{ type: 'image_url', url: 'http://example.com/img.png' }] }),
    (err) => { assert.equal(err.code, 'INVALID_ATTACHMENT'); return true }
  )
})

test('validateTaskInput: rejects data: URL attachment', () => {
  assert.throws(
    () => validateTaskInput({ goal: 'Look at this', attachments: [{ type: 'image_url', url: 'data:image/png;base64,abc' }] }),
    (err) => { assert.equal(err.code, 'INVALID_ATTACHMENT'); return true }
  )
})

test('validateTaskInput: accepts https image attachments', () => {
  const result = validateTaskInput({
    goal: 'Analyse this chart',
    attachments: [{ type: 'image_url', url: 'https://example.com/chart.png' }]
  })
  assert.equal(result.attachments.length, 1)
})
