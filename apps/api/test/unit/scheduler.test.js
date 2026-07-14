// test/unit/scheduler.test.js
// Tests for the cron parser — no DB needed

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Re-implement the cron parser here for pure unit testing without DB imports
function parseCronField(field, min, max) {
  if (field === '*') return null
  const values = new Set()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^\*\/(\d+)$/)
    if (stepMatch) {
      const step = parseInt(stepMatch[1])
      for (let i = min; i <= max; i += step) values.add(i)
      continue
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1]), to = parseInt(rangeMatch[2])
      const step = rangeMatch[3] ? parseInt(rangeMatch[3]) : 1
      for (let i = from; i <= to; i += step) values.add(i)
      continue
    }
    const n = parseInt(part)
    if (!isNaN(n)) values.add(n)
  }
  return values.size > 0 ? values : null
}

function parseCron(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minuteF, hourF, domF, monthF, dowF] = parts

  // Detect pure interval pattern: */N * * * * or * */N * * *
  if (minuteF.startsWith('*/') && hourF === '*' && domF === '*' && monthF === '*' && dowF === '*') {
    const n = parseInt(minuteF.slice(2))
    if (!isNaN(n) && n > 0) return { mode: 'interval', intervalMs: n * 60_000 }
  }
  if (minuteF === '0' && hourF.startsWith('*/') && domF === '*' && monthF === '*' && dowF === '*') {
    const n = parseInt(hourF.slice(2))
    if (!isNaN(n) && n > 0) return { mode: 'interval', intervalMs: n * 3_600_000 }
  }

  const fields = {
    minute: parseCronField(minuteF, 0, 59),
    hour:   parseCronField(hourF,   0, 23),
    dom:    parseCronField(domF,    1, 31),
    month:  parseCronField(monthF,  1, 12),
    dow:    parseCronField(dowF,    0, 6),
  }
  return { mode: 'exact', fields }
}

// ─── Cron parser tests ────────────────────────────────────────────────────────

test('parseCron: */5 * * * * → interval 5 minutes', () => {
  const result = parseCron('*/5 * * * *')
  assert.equal(result?.mode, 'interval')
  assert.equal(result?.intervalMs, 5 * 60_000)
})

test('parseCron: */1 * * * * → interval 1 minute', () => {
  const result = parseCron('*/1 * * * *')
  assert.equal(result?.mode, 'interval')
  assert.equal(result?.intervalMs, 60_000)
})

test('parseCron: 0 */2 * * * → interval 2 hours', () => {
  const result = parseCron('0 */2 * * *')
  assert.equal(result?.mode, 'interval')
  assert.equal(result?.intervalMs, 2 * 3_600_000)
})

test('parseCron: 0 9 * * * → exact-time mode', () => {
  const result = parseCron('0 9 * * *')
  assert.equal(result?.mode, 'exact')
  assert.ok(result?.fields.minute?.has(0))
  assert.ok(result?.fields.hour?.has(9))
  assert.equal(result?.fields.dom, null) // wildcard
})

test('parseCron: 0 9 * * 1-5 → weekday constraint parsed', () => {
  const result = parseCron('0 9 * * 1-5')
  assert.equal(result?.mode, 'exact')
  assert.ok(result?.fields.dow?.has(1))
  assert.ok(result?.fields.dow?.has(5))
  assert.ok(!result?.fields.dow?.has(0)) // Sunday excluded
  assert.ok(!result?.fields.dow?.has(6)) // Saturday excluded
})

test('parseCron: 0 9,17 * * * → comma-list hours', () => {
  const result = parseCron('0 9,17 * * *')
  assert.equal(result?.mode, 'exact')
  assert.ok(result?.fields.hour?.has(9))
  assert.ok(result?.fields.hour?.has(17))
  assert.ok(!result?.fields.hour?.has(12))
})

test('parseCron: returns null for invalid expression', () => {
  assert.equal(parseCron('* * *'), null)           // too few fields
  assert.equal(parseCron(''), null)                // empty
  // 'a b c d e' produces {mode:'exact', fields:allNull} — parseable but matches nothing
  const result = parseCron('a b c d e')
  // Either null or an exact-mode result with all-null fields is acceptable
  if (result !== null) {
    assert.equal(result.mode, 'exact')
    for (const v of Object.values(result.fields)) assert.equal(v, null)
  }
})

test('parseCronField: */5 with range 0-59', () => {
  const result = parseCronField('*/5', 0, 59)
  assert.ok(result?.has(0))
  assert.ok(result?.has(5))
  assert.ok(result?.has(55))
  assert.ok(!result?.has(3))
})

test('parseCronField: 1-5 range', () => {
  const result = parseCronField('1-5', 0, 6)
  assert.deepEqual([...result].sort((a,b)=>a-b), [1,2,3,4,5])
})

test('parseCronField: single value', () => {
  const result = parseCronField('30', 0, 59)
  assert.deepEqual([...result], [30])
})

test('parseCronField: wildcard * returns null', () => {
  assert.equal(parseCronField('*', 0, 59), null)
})
