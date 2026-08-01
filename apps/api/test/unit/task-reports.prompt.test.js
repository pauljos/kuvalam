// Unit tests for prompt-splitting + report helpers in task-reports.js.
// These functions are pure (no DB) so they import cleanly. extractUserGuardrails
// is the core of Gap #1: separating user guardrails from the frozen archetype
// blob that older agents saved into system_prompt at creation time.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { extractUserGuardrails, normalizeChartType, formatKpiValue, escapeHtml } = await import('../../src/services/task-reports.js')

// ── extractUserGuardrails ────────────────────────────────────────────────────

test('extractUserGuardrails: returns plain custom instructions unchanged', () => {
  const custom = 'You are a research analyst for ACME Corp. Research topics thoroughly and cite your sources.'
  assert.equal(extractUserGuardrails(custom), custom)
})

test('extractUserGuardrails: preserves "You are a X for Y" prompts that have no archetype sections', () => {
  // Regression: must NOT wipe legitimate hand-written prompts that merely start
  // with "You are" but contain no generated ## YOUR ROLE / HOW TO WORK sections.
  const custom = 'You are a compliance auditor for ACME Corp. Review documents against regulatory requirements (GDPR, SOC2). Flag violations.'
  assert.equal(extractUserGuardrails(custom), custom)
})

test('extractUserGuardrails: strips a pure frozen archetype blob to empty', () => {
  const blob = `You are **Order Data Analyst**, a data analytics agent. Analyze orders.

## YOUR ROLE
You specialise in querying databases and producing reports.

## HOW TO WORK
1. Call listTables.
2. Call runQuery.

## CORE RULES (non-negotiable)
- NEVER fabricate data.`
  assert.equal(extractUserGuardrails(blob), '')
})

test('extractUserGuardrails: keeps custom guardrails that follow an archetype blob', () => {
  const mixed = `You are **Civil Engineer Agent**, a data analytics agent. Structural analysis.

## YOUR ROLE
You assist with structural tasks.

## CORE RULES
- Output valid SVG.

## Guardrails (from user scenario)
- Generate a proper SVG diagram of a simply supported beam.`
  const out = extractUserGuardrails(mixed)
  assert.ok(out.includes('## Guardrails (from user scenario)'), 'should keep the guardrails section')
  assert.ok(out.includes('simply supported beam'), 'should keep the guardrail content')
  assert.ok(!out.includes('## YOUR ROLE'), 'should strip the archetype YOUR ROLE section')
  assert.ok(!out.includes('## CORE RULES'), 'should strip the archetype CORE RULES section')
})

test('extractUserGuardrails: removes a corrupted JSON-template placeholder line', () => {
  // A previous refiner run once saved a literal "<the FULL new custom instructions...>"
  // placeholder. It must be dropped, leaving only the real guardrails.
  const corrupted = `<the FULL new custom instructions: keep existing content, add the new guardrails>

## Guardrails (from user scenario)
- Analyze all Jira sprints.`
  const out = extractUserGuardrails(corrupted)
  assert.ok(!out.includes('FULL new custom instructions'), 'placeholder must be removed')
  assert.ok(out.includes('Analyze all Jira sprints'), 'real guardrail preserved')
})

test('extractUserGuardrails: empty / null / whitespace input → empty string', () => {
  assert.equal(extractUserGuardrails(''), '')
  assert.equal(extractUserGuardrails('   '), '')
  assert.equal(extractUserGuardrails(null), '')
  assert.equal(extractUserGuardrails(undefined), '')
})

test('extractUserGuardrails: idempotent on already-clean guardrails', () => {
  const clean = '## Guardrails\n- Always verify column names with describeTable.'
  assert.equal(extractUserGuardrails(extractUserGuardrails(clean)), clean)
})

// ── small pure helpers (regression coverage) ─────────────────────────────────

test('normalizeChartType: maps common aliases to canonical types', () => {
  assert.equal(normalizeChartType('bar'), 'bar')
  assert.equal(normalizeChartType('pie'), 'pie')
  assert.equal(normalizeChartType('line'), 'line')
  assert.equal(normalizeChartType('doughnut'), 'doughnut')
})

test('escapeHtml: escapes HTML-significant characters', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\''), '&lt;b&gt;&quot;x&quot; &amp; \'y\'')
})

test('formatKpiValue: returns a string for numbers and passthrough for text', () => {
  assert.equal(typeof formatKpiValue(1234), 'string')
  assert.equal(formatKpiValue('abc'), 'abc')
})
