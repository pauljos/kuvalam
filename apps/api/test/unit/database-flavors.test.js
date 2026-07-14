// Smoke tests for multi-flavor database connector wiring.
// Real DB connections are NOT made here — we only verify the driver registry
// resolves for known flavors and rejects unknown ones.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-exactly-32chars!!'

const mod = await import('../../src/services/database-connector.service.js')
const { DRIVERS, getConnectorFlavor, buildPgConfig } = mod

test('DRIVERS registry exposes postgres, mysql, mariadb aliases', () => {
  assert.ok(DRIVERS.postgres, 'postgres driver missing')
  assert.ok(DRIVERS.mysql, 'mysql driver missing')
  assert.equal(DRIVERS.mariadb, DRIVERS.mysql, 'mariadb should alias mysql')
  assert.equal(DRIVERS.pg, DRIVERS.postgres, 'pg should alias postgres')
})

test('every driver implements the required interface', () => {
  const required = ['buildConfig', 'createPool', 'endPool', 'verify', 'listTables', 'describeTable', 'sampleTable', 'runQuery']
  for (const [name, driver] of Object.entries(DRIVERS)) {
    for (const fn of required) {
      assert.equal(typeof driver[fn], 'function', `${name}.${fn} must be a function`)
    }
  }
})

test('getConnectorFlavor defaults to postgres when unset', () => {
  const conn = { config: {} }
  assert.equal(getConnectorFlavor(conn), 'postgres')
})

test('getConnectorFlavor honours the stored flavor', () => {
  assert.equal(getConnectorFlavor({ config: { flavor: 'mysql' } }), 'mysql')
  assert.equal(getConnectorFlavor({ config: { flavor: 'MariaDB' } }), 'mariadb')
})

test('buildPgConfig rejects private hosts in production without opt-in', () => {
  const orig = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    assert.throws(
      () => buildPgConfig({ config: { host: '127.0.0.1', database: 'x', user: 'x', password: 'x' } }),
      /private\/internal/i
    )
    // Explicit opt-in should succeed
    const cfg = buildPgConfig({ config: { host: '127.0.0.1', database: 'x', user: 'x', password: 'x', allow_private_host: true } })
    assert.equal(cfg.host, '127.0.0.1')
  } finally {
    process.env.NODE_ENV = orig
  }
})

test('mysql driver buildConfig validates required fields', () => {
  const d = DRIVERS.mysql
  assert.throws(() => d.buildConfig({}), /host is required/i)
  assert.throws(() => d.buildConfig({ host: 'db.example.com' }), /database is required/i)
  assert.throws(() => d.buildConfig({ host: 'db.example.com', database: 'x' }), /user is required/i)
  assert.throws(() => d.buildConfig({ host: 'db.example.com', database: 'x', user: 'u', port: '99999' }), /port must be/i)
  const good = d.buildConfig({ host: 'db.example.com', database: 'x', user: 'u', password: 'p' })
  assert.equal(good.port, 3306, 'default mysql port should be 3306')
  assert.equal(good.database, 'x')
})

test('postgres driver defaults port to 5432', () => {
  const good = DRIVERS.postgres.buildConfig({ host: 'db.example.com', database: 'x', user: 'u', password: 'p' })
  assert.equal(good.port, 5432)
})
