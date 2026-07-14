// apps/api/src/services/crypto.service.js
// AES-256-GCM credential encryption/decryption
// All connector secrets are encrypted before DB storage

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12    // 96-bit IV for GCM
const TAG_LENGTH = 16   // 128-bit auth tag
const SALT_LENGTH = 32

/**
 * Derive a 256-bit key from the master secret + a per-record salt.
 * Using scrypt so brute-force is computationally expensive.
 */
function deriveKey(masterSecret, salt) {
  return scryptSync(masterSecret, salt, 32, { N: 16384, r: 8, p: 1 })
}

function getMasterSecret() {
  const secret = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must be set to a 32+ char secret in production')
    }
    // Dev fallback — NOT safe for production
    return 'kuvalam-dev-credential-key-min-32-chars'
  }
  return secret
}

/**
 * Encrypt a plaintext string.
 * Returns a URL-safe base64 string: salt:iv:tag:ciphertext
 */
export function encrypt(plaintext) {
  if (!plaintext) return plaintext

  const master = getMasterSecret()
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = deriveKey(master, salt)

  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Encode as: base64(salt) : base64(iv) : base64(tag) : base64(ciphertext)
  return [
    salt.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64')
  ].join(':')
}

/**
 * Decrypt a previously encrypted string.
 */
export function decrypt(ciphertext) {
  if (!ciphertext || !ciphertext.includes(':')) return ciphertext

  const master = getMasterSecret()
  const parts = ciphertext.split(':')
  if (parts.length !== 4) return ciphertext // Not encrypted — pass through

  const [saltB64, ivB64, tagB64, dataB64] = parts
  const salt = Buffer.from(saltB64, 'base64')
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')

  const key = deriveKey(master, salt)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  return decrypted.toString('utf8')
}

/**
 * Encrypt all string values in a credentials object.
 * Non-string values (urls, booleans) are left as-is.
 */
export function encryptCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') return credentials
  const result = {}
  for (const [key, value] of Object.entries(credentials)) {
    // Encrypt only obvious secret fields
    const isSecret = /token|secret|password|key|credential/i.test(key)
    result[key] = (isSecret && typeof value === 'string') ? encrypt(value) : value
  }
  return result
}

/**
 * Decrypt all encrypted values in a stored credentials object.
 */
export function decryptCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') return credentials
  const result = {}
  for (const [key, value] of Object.entries(credentials)) {
    result[key] = typeof value === 'string' ? decrypt(value) : value
  }
  return result
}
