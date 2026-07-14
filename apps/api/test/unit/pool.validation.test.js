// test/unit/pool.validation.test.js
// Tests for the UUID tenant ID validator — no real DB connection needed

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── Replicate the validation logic from pool.js ──────────────────────────────
// We test the logic in isolation to avoid creating a real PG pool

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateTenantId(tenantId) {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`Invalid tenant ID format: ${tenantId}`)
  }
  return tenantId
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('validateTenantId: accepts lowercase UUID v4', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000'
  assert.equal(validateTenantId(id), id)
})

test('validateTenantId: accepts uppercase UUID', () => {
  const id = '550E8400-E29B-41D4-A716-446655440000'
  assert.equal(validateTenantId(id), id)
})

test('validateTenantId: accepts mixed-case UUID', () => {
  const id = '550e8400-E29B-41d4-A716-446655440000'
  assert.equal(validateTenantId(id), id)
})

test('validateTenantId: rejects simple string injection', () => {
  assert.throws(
    () => validateTenantId("'; DROP TABLE tenants; --"),
    /Invalid tenant ID format/
  )
})

test('validateTenantId: rejects empty string', () => {
  assert.throws(() => validateTenantId(''), /Invalid tenant ID format/)
})

test('validateTenantId: rejects null', () => {
  assert.throws(() => validateTenantId(null), /Invalid tenant ID format/)
})

test('validateTenantId: rejects UUID without hyphens', () => {
  assert.throws(
    () => validateTenantId('550e8400e29b41d4a716446655440000'),
    /Invalid tenant ID format/
  )
})

test('validateTenantId: rejects UUID with extra characters', () => {
  assert.throws(
    () => validateTenantId('550e8400-e29b-41d4-a716-44665544000x'),
    /Invalid tenant ID format/
  )
})

test('validateTenantId: rejects a numeric string', () => {
  assert.throws(
    () => validateTenantId('12345'),
    /Invalid tenant ID format/
  )
})

test('validateTenantId: rejects UUID with wrong segment lengths', () => {
  // One extra char in first segment
  assert.throws(
    () => validateTenantId('550e8400a-e29b-41d4-a716-446655440000'),
    /Invalid tenant ID format/
  )
})
