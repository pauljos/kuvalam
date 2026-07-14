// test/unit/database-connector.test.js
// Unit tests for the read-only SQL guard used by the DB connector tool.
// These are pure-string tests — no DB connection required.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-exactly-32chars!!'

const { assertReadOnlySql } = await import('../../src/services/database-connector.service.js')

test('accepts a plain SELECT', () => {
  const out = assertReadOnlySql('SELECT * FROM users WHERE id = $1')
  assert.match(out, /^SELECT/)
})

test('accepts a WITH … SELECT (CTE)', () => {
  const out = assertReadOnlySql('WITH t AS (SELECT 1) SELECT * FROM t')
  assert.match(out, /^WITH/i)
})

test('strips a trailing semicolon', () => {
  const out = assertReadOnlySql('SELECT 1;')
  assert.equal(out.endsWith(';'), false)
})

test('rejects INSERT / UPDATE / DELETE', () => {
  for (const stmt of ['INSERT INTO users(id) VALUES (1)', 'UPDATE users SET x=1', 'DELETE FROM users']) {
    assert.throws(() => assertReadOnlySql(stmt), /Only SELECT/i, `should reject: ${stmt}`)
  }
})

test('rejects DDL: DROP / CREATE / ALTER / TRUNCATE', () => {
  for (const stmt of ['DROP TABLE t', 'CREATE TABLE t(x int)', 'ALTER TABLE t ADD COLUMN x int', 'TRUNCATE t']) {
    assert.throws(() => assertReadOnlySql(stmt), /Only SELECT/i)
  }
})

test('rejects GRANT / REVOKE / CALL / DO / COPY', () => {
  for (const stmt of ['GRANT ALL ON t TO admin', 'REVOKE ALL ON t FROM admin', 'CALL sp_x()', 'DO $$ BEGIN NULL; END $$', 'COPY t TO STDOUT']) {
    assert.throws(() => assertReadOnlySql(stmt), /Only SELECT|Multi-statement/i)
  }
})

test('rejects multi-statement queries', () => {
  assert.throws(
    () => assertReadOnlySql('SELECT 1; DELETE FROM users'),
    /Multi-statement/i
  )
})

test('rejects DML hidden inside a CTE', () => {
  assert.throws(
    () => assertReadOnlySql('WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x'),
    /Data-modifying/i
  )
  assert.throws(
    () => assertReadOnlySql('WITH x AS (INSERT INTO t VALUES(1) RETURNING *) SELECT * FROM x'),
    /Data-modifying/i
  )
})

test('ignores block and line comments when validating', () => {
  const out = assertReadOnlySql('/* leading */ -- note\nSELECT 1')
  assert.match(out, /SELECT 1/)
})

test('rejects empty / non-string input', () => {
  assert.throws(() => assertReadOnlySql(''), /required/i)
  assert.throws(() => assertReadOnlySql('   '), /required/i)
  assert.throws(() => assertReadOnlySql(null), /required/i)
  assert.throws(() => assertReadOnlySql(42), /required/i)
})
