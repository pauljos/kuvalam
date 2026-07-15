// apps/api/src/services/cache.service.js
// Redis caching layer for frequently accessed data

import { Redis } from 'ioredis'

let redis = null
let cacheEnabled = false

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

// Get from cache
export async function get(key) {
  if (!cacheEnabled || !redis) return null
  try {
    const data = await redis.get(key)
    return data ? JSON.parse(data) : null
  } catch (err) {
    console.error('[Cache] Get error:', err.message)
    return null
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

// Delete multiple keys by pattern
export async function delPattern(pattern) {
  if (!cacheEnabled || !redis) return false
  try {
    const keys = await redis.keys(pattern)
    if (keys.length > 0) {
      await redis.del(...keys)
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
  const cached = await get(key)
  if (cached !== null) {
    return cached
  }

  // Execute function
  const result = await fn()

  // Cache result
  await set(key, result, ttl)

  return result
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
