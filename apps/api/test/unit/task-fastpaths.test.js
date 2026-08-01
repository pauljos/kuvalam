// Unit tests for the deterministic fast-paths (beam diagram + Jira dashboard)
// and the refiner's JSON parser. These guard against regex/logic regressions
// that would silently break the no-LLM fast-paths for qwen3-class agents.
// All functions under test are pure — no DB or network is touched.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'test-encryption-key-exactly-32chars!!'

const { parseBeamSpec, detectJiraDashboardGoal, computeJiraMetrics } = await import('../../src/services/task.service.js')
const { parseRefineJson } = await import('../../src/services/agent.service.js')

// ── parseBeamSpec ────────────────────────────────────────────────────────────

test('parseBeamSpec: extracts length, load and material from a full goal', () => {
  const s = parseBeamSpec('Simply supported steel beam, 25 kN/m over a 6 meter span')
  assert.equal(s.length, '6 m')
  assert.equal(s.loadValue, '25 kN/m')
  assert.equal(s.material, 'Steel')
  assert.equal(s.loadType, 'UDL')
  assert.equal(s.supportLeft, 'Pinned')
  assert.equal(s.supportRight, 'Roller')
})

test('parseBeamSpec: cantilever → fixed left, free right', () => {
  const s = parseBeamSpec('cantilever concrete beam 4 m point load')
  assert.equal(s.supportLeft, 'Fixed')
  assert.equal(s.supportRight, 'Free')
  assert.equal(s.loadType, 'Point Load')
  assert.equal(s.material, 'Concrete')
})

test('parseBeamSpec: falls back to sensible defaults when no numbers present', () => {
  const s = parseBeamSpec('draw a beam')
  assert.equal(s.length, '6 m')
  assert.equal(s.loadValue, '25 kN/m')
  assert.equal(s.material, 'Steel')
})

test('parseBeamSpec: handles empty / null input without throwing', () => {
  assert.equal(parseBeamSpec('').length, '6 m')
  assert.equal(parseBeamSpec(null).material, 'Steel')
})

// ── detectJiraDashboardGoal ──────────────────────────────────────────────────

test('detectJiraDashboardGoal: matches a Jira sprint dashboard request', () => {
  assert.equal(detectJiraDashboardGoal('Analyze all Jira sprints and create a dashboard report showing velocity and burndown'), true)
  assert.equal(detectJiraDashboardGoal('Jira sprint velocity report'), true)
  assert.equal(detectJiraDashboardGoal('show sprint burndown chart'), true)
})

test('detectJiraDashboardGoal: rejects non-Jira and pure-diagram goals', () => {
  assert.equal(detectJiraDashboardGoal('draw a structural beam diagram'), false)
  assert.equal(detectJiraDashboardGoal('what is the weather today'), false)
  // "report" alone without jira/sprint+dashboard keywords → false
  assert.equal(detectJiraDashboardGoal('write a report about sales'), false)
})

// ── computeJiraMetrics ───────────────────────────────────────────────────────

function sprint(over = {}) {
  return {
    id: 1, name: 'MODE Sprint 1', state: 'closed', total: 10, doneCount: 8,
    committedPts: 20, donePts: 16, doneResolutions: [], ...over,
  }
}

test('computeJiraMetrics: computes completion rate and velocity', () => {
  const data = { sprints: [sprint({ id: 1 }), sprint({ id: 2, total: 10, doneCount: 5, committedPts: 20, donePts: 10 })] }
  const m = computeJiraMetrics(data)
  assert.equal(m.totalIssues, 20)
  assert.equal(m.totalDoneCount, 13)
  assert.equal(m.completionRate, 65) // 13/20
  assert.equal(m.closedCount, 2)
  assert.equal(m.velocity.length, 2)
  // Strips the "MODE " prefix from sprint names
  assert.equal(m.velocity[0].name, 'Sprint 1')
})

test('computeJiraMetrics: handles empty sprint list without throwing', () => {
  const m = computeJiraMetrics({ sprints: [] })
  assert.equal(m.totalIssues, 0)
  assert.equal(m.completionRate, 0)
  assert.equal(m.burndown, null)
})

test('computeJiraMetrics: builds a burndown for the active sprint', () => {
  const active = sprint({
    id: 3, state: 'active', committedPts: 20, donePts: 10,
    startDate: '2026-07-01T00:00:00Z', endDate: '2026-07-15T00:00:00Z',
    doneResolutions: [{ pts: 5, resolutiondate: '2026-07-02T00:00:00Z' }],
  })
  const m = computeJiraMetrics({ sprints: [active] })
  assert.ok(m.burndown, 'burndown should exist for an active sprint')
  assert.equal(m.burndown.committed, 20)
  assert.ok(Array.isArray(m.burndown.days) && m.burndown.days.length > 0, 'burndown has daily points')
})

// ── parseRefineJson ──────────────────────────────────────────────────────────

test('parseRefineJson: parses a clean JSON object', () => {
  const o = parseRefineJson('{"updatedSystemPrompt":"X","summary":"s","addedRules":["a"]}')
  assert.equal(o.updatedSystemPrompt, 'X')
  assert.deepEqual(o.addedRules, ['a'])
})

test('parseRefineJson: extracts JSON from a markdown code fence', () => {
  const o = parseRefineJson('Here you go:\n```json\n{"updatedSystemPrompt":"Y","summary":"s"}\n```\nDone.')
  assert.equal(o.updatedSystemPrompt, 'Y')
})

test('parseRefineJson: extracts the first balanced object from prose', () => {
  const o = parseRefineJson('Sure! {"updatedSystemPrompt":"Z","addedRules":[{"nested":1}]} hope this helps')
  assert.equal(o.updatedSystemPrompt, 'Z')
})

test('parseRefineJson: returns null for non-JSON / empty input', () => {
  assert.equal(parseRefineJson('no json here at all'), null)
  assert.equal(parseRefineJson(''), null)
  assert.equal(parseRefineJson(null), null)
})

test('parseRefineJson: respects braces inside strings (does not over-trim)', () => {
  const o = parseRefineJson('{"updatedSystemPrompt":"use {curly} braces","summary":"s"}')
  assert.equal(o.updatedSystemPrompt, 'use {curly} braces')
})
