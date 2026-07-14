// test/unit/memory.extraction.test.js
// Tests for the LLM-response JSON entity parser used in memory.service.js
// (tests the parsing logic without actually calling OpenAI)

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── Replicate the entity extraction parser from memory.service.js ────────────

function parseEntityJson(raw) {
  if (!raw) return []
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    return parsed.filter(e =>
      e && typeof e === 'object' &&
      typeof e.entity_type === 'string' && e.entity_type.length > 0 &&
      typeof e.entity_name === 'string' && e.entity_name.length > 0 &&
      typeof e.detail === 'string'
    )
  } catch {
    return []
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('parseEntityJson: parses clean JSON array', () => {
  const raw = JSON.stringify([
    { entity_type: 'PERSON', entity_name: 'Alice', detail: 'Lead engineer' },
    { entity_type: 'ORG',    entity_name: 'Acme Corp', detail: 'Client company' }
  ])
  const result = parseEntityJson(raw)
  assert.equal(result.length, 2)
  assert.equal(result[0].entity_name, 'Alice')
  assert.equal(result[1].entity_type, 'ORG')
})

test('parseEntityJson: extracts JSON embedded in prose', () => {
  const raw = `Here are the entities I found:\n[\n  {"entity_type":"PERSON","entity_name":"Bob","detail":"CTO"}\n]\nEnd of list.`
  const result = parseEntityJson(raw)
  assert.equal(result.length, 1)
  assert.equal(result[0].entity_name, 'Bob')
})

test('parseEntityJson: filters items missing required fields', () => {
  const raw = JSON.stringify([
    { entity_type: 'PERSON', entity_name: 'Alice', detail: 'OK' },
    { entity_type: '', entity_name: 'Ghost', detail: 'missing type' },         // empty type
    { entity_name: 'NoType', detail: 'no entity_type key' },                   // missing type
    { entity_type: 'ORG', detail: 'no entity_name key' },                      // missing name
  ])
  const result = parseEntityJson(raw)
  assert.equal(result.length, 1)
  assert.equal(result[0].entity_name, 'Alice')
})

test('parseEntityJson: returns empty array for invalid JSON', () => {
  assert.deepEqual(parseEntityJson('[invalid json}'), [])
})

test('parseEntityJson: returns empty array for empty string', () => {
  assert.deepEqual(parseEntityJson(''), [])
})

test('parseEntityJson: returns empty array for null/undefined', () => {
  assert.deepEqual(parseEntityJson(null), [])
  assert.deepEqual(parseEntityJson(undefined), [])
})

test('parseEntityJson: returns empty array when no JSON array present', () => {
  assert.deepEqual(parseEntityJson('No entities found in this text.'), [])
})

test('parseEntityJson: handles empty array', () => {
  assert.deepEqual(parseEntityJson('[]'), [])
})

test('parseEntityJson: rejects non-object array items', () => {
  const raw = JSON.stringify(['PERSON', null, 42, { entity_type: 'ORG', entity_name: 'Acme', detail: 'valid' }])
  const result = parseEntityJson(raw)
  assert.equal(result.length, 1)
  assert.equal(result[0].entity_name, 'Acme')
})
