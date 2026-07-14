// test/unit/workflow.interpolation.test.js
// Tests for the template interpolation helpers exported from workflow.service.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpolateTemplate, interpolateDeep, extractTemplateVars } from '../../src/services/workflow.service.js'

test('interpolateTemplate: simple {{var}} substitution', () => {
  assert.equal(interpolateTemplate('Hi {{name}}', { name: 'Alice' }), 'Hi Alice')
})

test('interpolateTemplate: dotted paths into a step output', () => {
  const ctx = { research: { answer: '42', refs: ['a', 'b'] } }
  assert.equal(interpolateTemplate('Answer: {{research.answer}}', ctx), 'Answer: 42')
  assert.equal(interpolateTemplate('First: {{research.refs.0}}', ctx), 'First: a')
  assert.equal(interpolateTemplate('Bracket: {{research.refs[1]}}', ctx), 'Bracket: b')
})

test('interpolateTemplate: whole object stringified', () => {
  const ctx = { s: { a: 1 } }
  assert.equal(interpolateTemplate('X {{s}} Y', ctx), 'X {"a":1} Y')
})

test('interpolateTemplate: unknown vars left as-is', () => {
  assert.equal(interpolateTemplate('Hi {{missing}}', {}), 'Hi {{missing}}')
  assert.equal(interpolateTemplate('{{a.b.c}}', { a: { b: {} } }), '{{a.b.c}}')
})

test('interpolateTemplate: null renders as literal "null", not missing', () => {
  assert.equal(interpolateTemplate('v={{x}}', { x: null }), 'v=null')
})

test('interpolateTemplate: no template chars = passthrough', () => {
  assert.equal(interpolateTemplate('plain string', {}), 'plain string')
  assert.equal(interpolateTemplate('', {}), '')
})

test('interpolateTemplate: non-string input passes through', () => {
  assert.equal(interpolateTemplate(42, {}), 42)
  assert.equal(interpolateTemplate(null, {}), null)
})

test('interpolateDeep: walks arrays and objects', () => {
  const ctx = { user: 'bob', order: { id: 7 } }
  const input = {
    to: '{{user}}@x.com',
    tags: ['t-{{user}}', 'id-{{order.id}}'],
    nested: { subject: 'Order {{order.id}} for {{user}}' }
  }
  assert.deepEqual(interpolateDeep(input, ctx), {
    to: 'bob@x.com',
    tags: ['t-bob', 'id-7'],
    nested: { subject: 'Order 7 for bob' }
  })
})

test('interpolateDeep: leaves non-string primitives untouched', () => {
  assert.deepEqual(interpolateDeep({ a: 1, b: true, c: null }, {}), { a: 1, b: true, c: null })
})

test('extractTemplateVars: returns unique tokens found', () => {
  assert.deepEqual(
    extractTemplateVars('Hi {{name}}, order {{order.id}} again {{name}}').sort(),
    ['name', 'order.id'].sort()
  )
  assert.deepEqual(extractTemplateVars('plain'), [])
})
