// ═══════════════════════════════════════════════════════════════════════════════
// Safe Execution Utilities — prevent command injection vulnerabilities
// ═══════════════════════════════════════════════════════════════════════════════

import { spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'

const execAsync = promisify(spawn)

/**
 * Execute a command safely using spawn with argument array (no shell interpolation)
 * @param {string} command - The command to run (must be in allowlist)
 * @param {string[]} args - Arguments array (no shell parsing)
 * @param {object} options - Spawn options
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function safeSpawn(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })

    child.on('close', (code) => {
      resolve({ stdout, stderr, code })
    })

    child.on('error', (err) => {
      reject(err)
    })

    // Timeout handling
    if (options.timeout) {
      setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Command timed out after ${options.timeout}ms`))
      }, options.timeout)
    }
  })
}

/**
 * Validate that a string contains only safe characters (no shell metacharacters)
 * @param {string} input - Input to validate
 * @param {RegExp} allowedPattern - Regex pattern for allowed characters
 * @returns {boolean}
 */
export function isSafeInput(input, allowedPattern = /^[a-zA-Z0-9_\-\.\/\@\:]+$/) {
  if (typeof input !== 'string') return false
  return allowedPattern.test(input)
}

/**
 * Sanitize a path to prevent directory traversal
 * @param {string} userPath - User-provided path
 * @param {string} basePath - Base directory to restrict to
 * @returns {string|null} - Sanitized absolute path or null if invalid
 */
export function sanitizePath(userPath, basePath = process.cwd()) {
  if (!userPath || typeof userPath !== 'string') return null
  
  // Resolve to absolute path
  const resolved = path.resolve(basePath, userPath)
  
  // Ensure it's within the base path
  if (!resolved.startsWith(path.resolve(basePath))) {
    return null
  }
  
  return resolved
}

/**
 * Search files using Node.js fs APIs (no shell commands)
 * @param {string} pattern - Regex pattern to search for
 * @param {string} searchPath - Directory to search
 * @param {object} options - Search options
 * @returns {Promise<Array>} - Array of matches
 */
export async function searchFiles(pattern, searchPath, options = {}) {
  const {
    filePattern = '*',
    maxResults = 20,
    caseSensitive = false,
    maxDepth = 10
  } = options

  const results = []
  const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi')
  
  async function searchDir(dir, depth = 0) {
    if (depth > maxDepth || results.length >= maxResults) return
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      
      for (const entry of entries) {
        if (results.length >= maxResults) break
        
        const fullPath = path.join(dir, entry.name)
        
        if (entry.isDirectory()) {
          // Skip node_modules, .git, etc.
          if (!['node_modules', '.git', '.svn', 'dist', 'build'].includes(entry.name)) {
            await searchDir(fullPath, depth + 1)
          }
        } else if (entry.isFile()) {
          // Check file pattern
          if (filePattern !== '*' && !entry.name.match(new RegExp(filePattern.replace('*', '.*')))) {
            continue
          }
          
          try {
            const content = await fs.readFile(fullPath, 'utf8')
            const lines = content.split('\n')
            
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              if (regex.test(lines[i])) {
                results.push({
                  file: fullPath,
                  line: i + 1,
                  content: lines[i].trim(),
                  match: lines[i].match(regex)?.[0]
                })
              }
            }
          } catch (err) {
            // Skip binary files or unreadable files
            continue
          }
        }
      }
    } catch (err) {
      // Skip unreadable directories
      return
    }
  }
  
  await searchDir(searchPath)
  return results
}

/**
 * Validate Docker image name against allowlist
 * @param {string} image - Docker image name
 * @returns {boolean}
 */
export function isValidDockerImage(image) {
  if (!image || typeof image !== 'string') return false
  
  // Allow official images and common patterns
  const allowedPatterns = [
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,  // simple names like 'alpine', 'python'
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*:[a-z0-9]+(?:[._-][a-z0-9]+)*$/,  // with tag like 'python:3.12'
    /^[a-z0-9]+\/[a-z0-9]+(?:[._-][a-z0-9]+)*(:[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/,  // org/name:tag
  ]
  
  return allowedPatterns.some(pattern => pattern.test(image))
}

/**
 * Validate hostname or IP address
 * @param {string} host - Hostname or IP
 * @returns {boolean}
 */
export function isValidHost(host) {
  if (!host || typeof host !== 'string') return false
  
  // Block dangerous hosts
  const dangerous = [
    'localhost', '127.0.0.1', '::1',
    '0.0.0.0', '169.254.169.254',  // cloud metadata
    'metadata.google.internal'
  ]
  
  if (dangerous.includes(host.toLowerCase())) return false
  
  // Validate format (hostname or IPv4)
  const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/
  
  return hostnamePattern.test(host) || ipv4Pattern.test(host)
}

/**
 * Assert URL is safe (not internal/private)
 * @param {string} url - URL to validate
 * @throws {Error} If URL is unsafe
 */
export function assertSafeUrl(url) {
  const parsed = new URL(url)
  
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must be HTTP or HTTPS')
  }
  
  const host = parsed.hostname.toLowerCase()
  
  // Block private/internal addresses
  const privatePatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,  // link-local
    /^::1$/,
    /^fc00:/,  // IPv6 private
    /^fe80:/,  // IPv6 link-local
  ]
  
  for (const pattern of privatePatterns) {
    if (pattern.test(host)) {
      throw new Error('URL must not target private/internal addresses')
    }
  }
  
  return true
}
