#!/usr/bin/env node
// test/run-all.js
// Master test runner — discovers and runs all test files in order
// Run: node test/run-all.js

import { run } from 'node:test'
import { spec } from 'node:test/reporters'
import { glob } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Collect test files — unit tests first, then integration
const files = []
for await (const f of glob(path.join(__dirname, '**/*.test.js'))) {
  files.push(f)
}
files.sort((a, b) => {
  // unit tests first
  const aIsUnit = a.includes('/unit/')
  const bIsUnit = b.includes('/unit/')
  if (aIsUnit && !bIsUnit) return -1
  if (!aIsUnit && bIsUnit) return 1
  return a.localeCompare(b)
})

console.log(`\nRunning ${files.length} test files...\n`)

const stream = run({
  files,
  concurrency: 1,  // sequential for predictability
})

try {
  await pipeline(stream, spec(), process.stdout)
} catch {
  process.exit(1)
}
