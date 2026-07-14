// Unit tests for connector tool definitions.
// Verifies that every provider we advertise in the UI catalog actually exposes
// at least one tool definition that the LLM can call — this is the check that
// would have caught Notion/Linear/Salesforce being "configurable but useless".

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-exactly-32chars!!'

const mod = await import('../../src/services/connector-tools.service.js')
const { CONNECTOR_TOOL_PREFIXES } = mod

// Access the internal `toolDefsForProvider` indirectly by calling the public
// `getConnectorToolDefinitions` isn't possible without a DB, so we assert on
// the exported prefix list + a shape check via a minimal wrapper.
// The public function we CAN reach is the prefix registry.

test('CONNECTOR_TOOL_PREFIXES registers every provider surfaced in the UI', () => {
  const expected = ['slack__', 'jira__', 'github__', 'gmail__', 'notion__', 'linear__', 'salesforce__', 'webhook__', 'db__', 'rest__']
  for (const p of expected) {
    assert.ok(CONNECTOR_TOOL_PREFIXES.includes(p), `${p} must be registered`)
  }
})

test('CONNECTOR_TOOL_PREFIXES has no duplicates', () => {
  const set = new Set(CONNECTOR_TOOL_PREFIXES)
  assert.equal(set.size, CONNECTOR_TOOL_PREFIXES.length, 'prefix list contains duplicates')
})

// Import the private helper by re-evaluating the module in a way that exposes it.
// The cleanest approach is to expose it — see the sibling patch in
// connector-tools.service.js that exports `_toolDefsForProvider` for tests only.
test('every provider in the switch statement returns at least one tool def', async () => {
  // We validate by constructing a fake conn row per provider and checking the
  // exported prefix matches at least one tool name.
  // Since toolDefsForProvider is module-private, we assert indirectly: each
  // known provider prefix corresponds to a real handler branch in
  // executeConnectorTool. We check this by looking at the source text once.
  const fs = await import('node:fs/promises')
  const url = new URL('../../src/services/connector-tools.service.js', import.meta.url)
  const src = await fs.readFile(url, 'utf8')

  const providerSlugs = ['slack', 'jira', 'github', 'gmail', 'notion', 'linear', 'salesforce', 'webhook']
  for (const p of providerSlugs) {
    // Must have a `case '<provider>':` branch in toolDefsForProvider
    assert.ok(
      new RegExp(`case '${p}':\\s*return \\[`).test(src),
      `toolDefsForProvider missing "case '${p}':" branch — provider is in UI but has no tools`
    )
    // Must have at least one `case '<provider>__…':` branch in executeConnectorTool
    assert.ok(
      new RegExp(`case '${p}__[a-z_]+':`).test(src),
      `executeConnectorTool missing dispatch for "${p}__*" — tools defined but not executable`
    )
  }
})

test('Slack advertises the expanded operation set', async () => {
  const fs = await import('node:fs/promises')
  const url = new URL('../../src/services/connector-tools.service.js', import.meta.url)
  const src = await fs.readFile(url, 'utf8')
  const expected = ['slack__post_message', 'slack__update_message', 'slack__list_channels', 'slack__get_history', 'slack__add_reaction', 'slack__lookup_user']
  for (const t of expected) {
    assert.ok(src.includes(`name: '${t}'`), `Slack missing tool: ${t}`)
    assert.ok(src.includes(`case '${t}':`), `Slack missing dispatch for: ${t}`)
  }
})

test('Notion advertises page/database operations', async () => {
  const fs = await import('node:fs/promises')
  const url = new URL('../../src/services/connector-tools.service.js', import.meta.url)
  const src = await fs.readFile(url, 'utf8')
  const expected = ['notion__search', 'notion__retrieve_page', 'notion__create_page', 'notion__query_database', 'notion__append_blocks']
  for (const t of expected) {
    assert.ok(src.includes(`name: '${t}'`), `Notion missing tool: ${t}`)
  }
})

test('Linear advertises issue lifecycle operations', async () => {
  const fs = await import('node:fs/promises')
  const url = new URL('../../src/services/connector-tools.service.js', import.meta.url)
  const src = await fs.readFile(url, 'utf8')
  const expected = ['linear__list_teams', 'linear__create_issue', 'linear__search_issues', 'linear__update_issue', 'linear__add_comment']
  for (const t of expected) {
    assert.ok(src.includes(`name: '${t}'`), `Linear missing tool: ${t}`)
  }
})

test('Salesforce advertises SOQL + record operations', async () => {
  const fs = await import('node:fs/promises')
  const url = new URL('../../src/services/connector-tools.service.js', import.meta.url)
  const src = await fs.readFile(url, 'utf8')
  const expected = ['salesforce__query', 'salesforce__describe_object', 'salesforce__create_record', 'salesforce__update_record']
  for (const t of expected) {
    assert.ok(src.includes(`name: '${t}'`), `Salesforce missing tool: ${t}`)
  }
})
