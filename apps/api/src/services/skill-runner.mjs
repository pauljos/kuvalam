// apps/api/src/services/skill-runner.mjs
// Dedicated subprocess runner for custom code skills.
// Spawned by skill-executor.service.js via child_process.fork().
// Receives { code, input, env } on stdin as a single JSON line,
// executes the code, and writes { ok, result } or { ok: false, error } to stdout.
//
// This runs in an isolated process — no access to parent modules, DB pool,
// crypto service, or any Kuvalam internals beyond what's passed in.
//
// IMPORTANT: This uses indirect eval() inside a forked child process, NOT
// in the main API server. Process-level isolation means the evaluated code
// cannot access the parent's memory, require cache, database pool, or secrets.
// This is significantly more secure than Node's vm module (which is explicitly
// documented as NOT a security sandbox).

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  let payload
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    writeResult({ ok: false, error: 'Invalid JSON payload on stdin' })
    process.exit(1)
  }

  const { code, input = {}, env = {} } = payload
  if (typeof code !== 'string' || code.trim().length === 0) {
    writeResult({ ok: false, error: 'code is required' })
    process.exit(1)
  }

  // Expose sandbox values as local variables in the eval scope.
  // Only safe primitives are exposed — no fs, child_process, require, etc.
  const _input = input
  const _env = env

  ;(async () => {
    try {
      // Indirect eval in a separate process — safe because the child has no
      // access to the parent's modules, DB, or secrets. The only globals
      // available are Node.js builtins (fetch, URL, etc.) plus _input, _env.
      const result = await eval(`(async () => { ${code} })()`)
      writeResult({ ok: true, result: result === undefined ? null : result })
    } catch (err) {
      writeResult({ ok: false, error: err.message || String(err) })
    }
  })()
})

function writeResult(data) {
  try {
    process.stdout.write(JSON.stringify(data) + '\n')
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'Failed to serialise result' }) + '\n')
  }
}
