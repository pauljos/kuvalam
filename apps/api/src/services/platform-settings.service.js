// apps/api/src/services/platform-settings.service.js
// Platform-level settings that only sysadmins can configure.
// Settings are stored in the 'platform_settings' table (key/value pairs)
// and cached in-process for 5 minutes to avoid DB reads on every request.
//
// Design: disabled by default, opt-in per feature.
//
// Usage:
//   const { getEmailVerificationRequired } = await import('./platform-settings.service.js')
//   const required = await getEmailVerificationRequired()

import { query } from '../db/pool.js'

// ─── In-process cache ────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60_000  // 5 minutes
const cache = new Map() // key -> { value, expiresAt }

async function getSetting(key, defaultValue) {
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) return cached.value

  try {
    const { rows: [row] } = await query(
      `SELECT value FROM platform_settings WHERE key = $1`,
      [key]
    )
    const value = row ? row.value : defaultValue
    cache.set(key, { value, expiresAt: now + CACHE_TTL_MS })
    return value
  } catch {
    // Table may not exist yet (before migration) — return default
    return defaultValue
  }
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  )
  // Invalidate cache immediately
  cache.delete(key)
}

// ─── Named setting accessors ─────────────────────────────────────────────────

/**
 * Whether email verification must be completed before an account can be used.
 * Default: false (disabled) — sysadmin must explicitly enable this.
 *
 * When enabled, the login route will return HTTP 403 if email_verified = false.
 * When disabled, a requiresEmailVerification flag is returned in the login
 * response so the frontend can show a soft warning banner.
 */
export async function getEmailVerificationRequired() {
  const val = await getSetting('email_verification_required', 'false')
  return val === 'true' || val === true
}

export async function setEmailVerificationRequired(enabled) {
  await setSetting('email_verification_required', enabled ? 'true' : 'false')
}

/**
 * List all current platform settings (for the sysadmin settings UI).
 * Returns an array of { key, value, updated_at } rows.
 */
export async function listPlatformSettings() {
  try {
    const { rows } = await query(
      `SELECT key, value, updated_at FROM platform_settings ORDER BY key`,
      []
    )
    // Merge with defaults so all known keys are always returned
    const known = {
      email_verification_required: 'false',
    }
    const result = { ...known }
    for (const row of rows) result[row.key] = row.value

    return Object.entries(result).map(([key, value]) => {
      const fromDb = rows.find(r => r.key === key)
      return { key, value, updated_at: fromDb?.updated_at || null }
    })
  } catch {
    return []
  }
}
