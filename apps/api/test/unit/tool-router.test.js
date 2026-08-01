// Unit tests for the G2 goal-relevance tool router (annotateIrrelevantTools).
// Small models see a flat list of every tool and mis-pick; the router annotates
// clearly-irrelevant ACTION tools so the model deprioritizes them. Pure — no DB.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'test-encryption-key-exactly-32chars!!'

const { annotateIrrelevantTools } = await import('../../src/services/task.service.js')

test('annotateIrrelevantTools: irrelevant namespaced action tool is annotated', () => {
  const tools = [
    { name: 'jira__create_issue', description: 'Create a Jira issue in a project' },
    { name: 'http_request', description: 'Make an HTTP request' },
  ]
  const n = annotateIrrelevantTools(tools, 'Fetch the homepage HTML from https://example.com')
  assert.equal(n, 1)
  assert.match(tools[0].description, /LIKELY IRRELEVANT/)
  // Core tool untouched
  assert.equal(tools[1].description, 'Make an HTTP request')
})

test('annotateIrrelevantTools: relevant tool is NOT annotated', () => {
  const tools = [
    { name: 'jira__create_issue', description: 'Create a Jira issue in a project' },
  ]
  const n = annotateIrrelevantTools(tools, 'Create a Jira issue for the login bug')
  assert.equal(n, 0)
  assert.equal(tools[0].description, 'Create a Jira issue in a project')
})

test('annotateIrrelevantTools: core/data tools are never annotated even if irrelevant', () => {
  const tools = [
    { name: 'runQuery', description: 'Run a SQL query' },
    { name: 'write_artifact', description: 'Write a file artifact' },
    { name: 'searchKnowledge', description: 'Search knowledge bases' },
  ]
  const n = annotateIrrelevantTools(tools, 'Post a message to the marketing Slack channel')
  assert.equal(n, 0)
  assert.equal(tools[0].description, 'Run a SQL query')
})

test('annotateIrrelevantTools: write-verb non-namespaced tool gets annotated when irrelevant', () => {
  const tools = [
    { name: 'sendEmail', description: 'Send an email to a recipient' },
  ]
  const n = annotateIrrelevantTools(tools, 'Query the database for top customers')
  assert.equal(n, 1)
  assert.match(tools[0].description, /LIKELY IRRELEVANT/)
})

test('annotateIrrelevantTools: empty goal annotates nothing', () => {
  const tools = [{ name: 'jira__create_issue', description: 'Create a Jira issue' }]
  assert.equal(annotateIrrelevantTools(tools, ''), 0)
  assert.equal(annotateIrrelevantTools(tools, null), 0)
  assert.equal(tools[0].description, 'Create a Jira issue')
})

test('annotateIrrelevantTools: empty/missing tool list is a no-op', () => {
  assert.equal(annotateIrrelevantTools([], 'do something'), 0)
  assert.equal(annotateIrrelevantTools(null, 'do something'), 0)
})

test('annotateIrrelevantTools: stop-words do not count as relevance signal', () => {
  // Goal made only of stop-words → goalTokenSet empties → nothing annotated.
  const tools = [{ name: 'jira__create_issue', description: 'Create a Jira issue' }]
  const n = annotateIrrelevantTools(tools, 'create the a an and or for to of in on with from using')
  assert.equal(n, 0)
})

test('annotateIrrelevantTools: multiple irrelevant tools all annotated', () => {
  const tools = [
    { name: 'jira__create_issue', description: 'Create a Jira issue' },
    { name: 'slack__post_message', description: 'Post a message to Slack' },
    { name: 'github__merge_pr', description: 'Merge a pull request' },
  ]
  const n = annotateIrrelevantTools(tools, 'Run a SQL query against the orders table')
  assert.equal(n, 3)
  for (const t of tools) assert.match(t.description, /LIKELY IRRELEVANT/)
})
