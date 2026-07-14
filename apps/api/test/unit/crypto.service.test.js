// test/unit/crypto.service.test.js
// Tests for credential encryption/decryption — no DB needed

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Set required env var before importing
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-exactly-32chars!!'

const { encryptCredentials, decryptCredentials, encrypt, decrypt } = await import('../../src/services/crypto.service.js')

test('encrypt/decrypt round-trip', () => {
  const original = 'super-secret-api-key-12345'
  const encrypted = encrypt(original)
  assert.notEqual(encrypted, original)
  assert.equal(decrypt(encrypted), original)
})

test('encrypt produces different ciphertext each time (IV randomness)', () => {
  const text = 'same-input'
  const enc1 = encrypt(text)
  const enc2 = encrypt(text)
  assert.notEqual(enc1, enc2, 'Each encryption should use a random IV')
})

test('encryptCredentials encrypts secret fields, leaves non-secrets as-is', () => {
  const creds = { apiKey: 'sk-abc123', endpoint: 'https://api.example.com', retries: 3 }
  const encrypted = encryptCredentials(creds)
  // apiKey matches /token|secret|password|key|credential/ — must be encrypted
  assert.notEqual(encrypted.apiKey, 'sk-abc123', 'apiKey should be encrypted')
  // endpoint does NOT match the secret regex — left as-is
  assert.equal(encrypted.endpoint, 'https://api.example.com', 'endpoint should be unchanged')
  // Non-string values always left alone
  assert.equal(encrypted.retries, 3)
})

test('decryptCredentials round-trips correctly', () => {
  const original = { apiKey: 'sk-test-key', token: 'bearer-xyz', port: 443 }
  const encrypted = encryptCredentials(original)
  const decrypted = decryptCredentials(encrypted)
  assert.equal(decrypted.apiKey, original.apiKey)
  assert.equal(decrypted.token, original.token)
  assert.equal(decrypted.port, original.port)
})

test('decryptCredentials handles empty object', () => {
  const result = decryptCredentials({})
  assert.deepEqual(result, {})
})

test('decryptCredentials handles non-encrypted string gracefully', () => {
  // Should not throw — returns the value unchanged if it cannot be decrypted
  const result = decryptCredentials({ key: 'not-encrypted-value' })
  assert.ok(result) // Just shouldn't throw
})

test('encrypt returns input unchanged for falsy values', () => {
  assert.equal(encrypt(null), null)
  assert.equal(encrypt(''), '')
  assert.equal(encrypt(undefined), undefined)
})
