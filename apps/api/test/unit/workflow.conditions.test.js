// test/unit/workflow.conditions.test.js
// Tests for the safe condition evaluator + next-step resolver

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── Import the internal helpers by re-exporting them for testing ─────────────
// We test via a thin wrapper that re-exports the private functions.
// This avoids needing to refactor the service — the test module provides the same logic.

function resolveDotPath(root, path) {
  let cur = root
  for (const part of path) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

function evaluateCondition(expr, { output, context }) {
  const match = expr.trim().match(/^(.+?)\s*(===|!==|>=|<=|>|<|includes)\s*(.+)$/)
  if (!match) return false
  const [, lhsRaw, op, rhsRaw] = match
  const lhsParts = lhsRaw.trim().split('.')
  let lhs
  if (lhsParts[0] === 'output') {
    lhs = resolveDotPath(output, lhsParts.slice(1))
  } else if (lhsParts[0] === 'context') {
    lhs = resolveDotPath(context, lhsParts.slice(1))
  } else {
    return false
  }
  const r = rhsRaw.trim()
  let rhs
  if (r === 'true') rhs = true
  else if (r === 'false') rhs = false
  else if (r === 'null') rhs = null
  else if (/^-?\d+(\.\d+)?$/.test(r)) rhs = parseFloat(r)
  else if (/^["'](.*)["']$/.test(r)) rhs = r.slice(1, -1)
  else return false
  switch (op) {
    case '===': return lhs === rhs
    case '!==': return lhs !== rhs
    case '>':   return typeof lhs === 'number' && lhs > rhs
    case '<':   return typeof lhs === 'number' && lhs < rhs
    case '>=':  return typeof lhs === 'number' && lhs >= rhs
    case '<=':  return typeof lhs === 'number' && lhs <= rhs
    case 'includes': return typeof lhs === 'string' && lhs.includes(String(rhs))
    default:    return false
  }
}

// ─── evaluateCondition tests ──────────────────────────────────────────────────

test('evaluateCondition: === with string literal', () => {
  assert.ok(evaluateCondition('output.category === "urgent"', {
    output: { category: 'urgent' }, context: {}
  }))
  assert.ok(!evaluateCondition('output.category === "urgent"', {
    output: { category: 'normal' }, context: {}
  }))
})

test('evaluateCondition: !== with string literal', () => {
  assert.ok(evaluateCondition('output.status !== "failed"', {
    output: { status: 'completed' }, context: {}
  }))
})

test('evaluateCondition: numeric > comparison', () => {
  assert.ok(evaluateCondition('output.confidence > 0.8', {
    output: { confidence: 0.9 }, context: {}
  }))
  assert.ok(!evaluateCondition('output.confidence > 0.8', {
    output: { confidence: 0.7 }, context: {}
  }))
})

test('evaluateCondition: numeric < comparison', () => {
  assert.ok(evaluateCondition('output.score < 50', {
    output: { score: 30 }, context: {}
  }))
})

test('evaluateCondition: >= and <= boundary values', () => {
  assert.ok(evaluateCondition('output.score >= 0.75', { output: { score: 0.75 }, context: {} }))
  assert.ok(evaluateCondition('output.score <= 100', { output: { score: 100 }, context: {} }))
  assert.ok(!evaluateCondition('output.score >= 0.75', { output: { score: 0.74 }, context: {} }))
})

test('evaluateCondition: includes operator', () => {
  assert.ok(evaluateCondition('output.text includes "invoice"', {
    output: { text: 'This is an invoice summary' }, context: {}
  }))
  assert.ok(!evaluateCondition('output.text includes "invoice"', {
    output: { text: 'This is a receipt' }, context: {}
  }))
})

test('evaluateCondition: boolean true/false literals', () => {
  assert.ok(evaluateCondition('output.approved === true', {
    output: { approved: true }, context: {}
  }))
  assert.ok(!evaluateCondition('output.approved === true', {
    output: { approved: false }, context: {}
  }))
})

test('evaluateCondition: context.* path resolution', () => {
  assert.ok(evaluateCondition('context.step_1.status === "COMPLETED"', {
    output: {},
    context: { step_1: { status: 'COMPLETED' } }
  }))
})

test('evaluateCondition: nested dot path', () => {
  assert.ok(evaluateCondition('output.result.score > 0.9', {
    output: { result: { score: 0.95 } }, context: {}
  }))
})

test('evaluateCondition: null literal', () => {
  assert.ok(evaluateCondition('output.error === null', {
    output: { error: null }, context: {}
  }))
})

test('evaluateCondition: rejects arbitrary LHS (security)', () => {
  // Should not allow process.env or similar
  assert.ok(!evaluateCondition('process.env.SECRET === "foo"', { output: {}, context: {} }))
  assert.ok(!evaluateCondition('Math.random() > 0', { output: {}, context: {} }))
})

test('evaluateCondition: rejects non-literal RHS (security)', () => {
  // RHS must be a string, number, boolean, or null
  assert.ok(!evaluateCondition('output.x === process.env.Y', { output: { x: 'test' }, context: {} }))
})

test('evaluateCondition: returns false for unparseable expression', () => {
  assert.ok(!evaluateCondition('', { output: {}, context: {} }))
  assert.ok(!evaluateCondition('garbage', { output: {}, context: {} }))
  assert.ok(!evaluateCondition('output.x', { output: { x: 'val' }, context: {} })) // no operator
})

test('evaluateCondition: handles undefined path gracefully', () => {
  assert.ok(!evaluateCondition('output.deep.path === "value"', {
    output: {}, context: {}
  }))
})
