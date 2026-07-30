// apps/api/src/services/cache.service.js
// Redis caching layer for frequently accessed data

import { Redis } from 'ioredis'

let redis = null
let cacheEnabled = false

// Sentinel used to distinguish "no cache entry" from "cached null value".
// Exported so callers can do: `if (result === CACHE_MISS) { ... }`
export const CACHE_MISS = Symbol('cache-miss')

// Initialize Redis connection
export function initCache() {
  if (!process.env.REDIS_URL) {
    console.warn('[Cache] REDIS_URL not set, caching disabled')
    return false
  }

  try {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    })

    redis.on('error', (err) => {
      console.error('[Cache] Redis error:', err.message)
      cacheEnabled = false
    })

    redis.on('connect', () => {
      console.log('[Cache] Redis connected')
      cacheEnabled = true
    })

    redis.connect().catch((err) => {
      console.error('[Cache] Failed to connect:', err.message)
      cacheEnabled = false
    })

    return true
  } catch (err) {
    console.error('[Cache] Init failed:', err.message)
    return false
  }
}

// Get from cache.
// Returns the cached value, or CACHE_MISS (exported symbol) if not found.
export async function get(key) {
  if (!cacheEnabled || !redis) return CACHE_MISS
  try {
    const data = await redis.get(key)
    return data !== null ? JSON.parse(data) : CACHE_MISS
  } catch (err) {
    console.error('[Cache] Get error:', err.message)
    return CACHE_MISS
  }
}

// Set to cache with TTL (in seconds)
export async function set(key, value, ttl = 300) {
  if (!cacheEnabled || !redis) return false
  try {
    await redis.setex(key, ttl, JSON.stringify(value))
    return true
  } catch (err) {
    console.error('[Cache] Set error:', err.message)
    return false
  }
}

// Delete from cache
export async function del(key) {
  if (!cacheEnabled || !redis) return false
  try {
    await redis.del(key)
    return true
  } catch (err) {
    console.error('[Cache] Del error:', err.message)
    return false
  }
}

/**
 * Delete all keys matching a glob pattern.
 *
 * Uses SCAN (cursor-based, non-blocking) instead of KEYS (blocking O(N)).
 * KEYS blocks the Redis event loop for the duration of the scan — on a
 * large keyspace this causes cascading timeouts across every Redis-dependent
 * feature (queues, scheduler locks, etc.).
 */
export async function delPattern(pattern) {
  if (!cacheEnabled || !redis) return false
  try {
    const toDelete = []
    let cursor = '0'
    do {
      // SCAN returns [nextCursor, [keys…]]
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = nextCursor
      toDelete.push(...keys)
    } while (cursor !== '0')

    if (toDelete.length > 0) {
      await redis.del(...toDelete)
    }
    return true
  } catch (err) {
    console.error('[Cache] DelPattern error:', err.message)
    return false
  }
}

// Cache wrapper - tries cache first, then executes fn and caches result
export async function cached(key, fn, ttl = 300) {
  // Try cache first
  const result = await get(key)
  if (result !== CACHE_MISS) {
    return result
  }

  // Execute function
  const value = await fn()

  // Cache result (null/undefined are valid cacheable values)
  await set(key, value, ttl)

  return value
}

// Invalidate all cache for a tenant
export async function invalidateTenant(tenantId) {
  return delPattern(`tenant:${tenantId}:*`)
}

// Shutdown
export async function shutdownCache() {
  if (redis) {
    await redis.quit()
  }
}
