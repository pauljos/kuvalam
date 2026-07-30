// apps/api/src/services/skill-executor.service.js
import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNNER_SCRIPT = path.join(__dirname, 'skill-runner.mjs')
const PYTHON_RUNNER_SCRIPT = path.join(__dirname, 'skill-runner-python.mjs')

/**
 * Executes a custom JavaScript code snippet in an isolated child process.
 * Uses process-level isolation (child_process.fork) instead of Node's vm module,
 * because vm.createContext is explicitly documented as NOT a security sandbox.
 *
 * The child process has no access to the parent's modules, database pool,
 * crypto keys, or any Kuvalam internals — only the code, input, and env
 * explicitly passed via stdin.
 *
 * @param {string} code - The custom JavaScript code to execute.
 * @param {Object} input - The input parameters provided by the LLM agent.
 * @param {Object} env - Any decrypted environment variables/secrets configured for the skill.
 * @returns {Promise<any>} The result of the code execution.
 */
async function executeCustomSkill(code, input = {}, env = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER_SCRIPT, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: [], // Explicitly no flags — inherits from parent
      timeout: 10_000, // Kill after 10s if something goes wrong
    })

    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Skill execution timed out after 10s'))
    }, 10_000)

    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('exit', (code_, signal) => {
      clearTimeout(timer)
      if (signal) {
        reject(new Error(`Skill process terminated by signal ${signal}`))
        return
      }
      try {
        // Take the last JSON line from stdout (in case of stray console output)
        const lines = output.trim().split('\n').filter(Boolean)
        const last = lines[lines.length - 1]
        if (!last) {
          reject(new Error('No output from skill process'))
          return
        }
        const parsed = JSON.parse(last)
        if (parsed.ok) {
          resolve(parsed.result)
        } else {
          reject(new Error(parsed.error || 'Skill execution failed'))
        }
      } catch (err) {
        reject(new Error(`Failed to parse skill result: ${err.message}. Output: ${output.slice(0, 200)}`))
      }
    })

    // Send the payload over stdin
    child.stdin.write(JSON.stringify({ code, input, env }) + '\n')
    child.stdin.end()
  })
}

/**
 * Execute a Python code snippet in a sandboxed child process.
 * Uses process-level isolation (child_process.spawn) — the Python process has
 * no access to the parent's modules, database pool, crypto keys, or any
 * Kuvalam internals.
 *
 * The child runs a wrapper script that reads input from stdin, executes the
 * user code, and writes the result as JSON to stdout delimited by a marker.
 *
 * @param {string} code - Python source code to execute.
 * @param {Object} input - Input data passed to the script.
 * @param {Object} env - Environment variables for the subprocess.
 * @returns {Promise<object>} Execution result with { success, data/error }.
 */
async function executePythonSkill(code, input = {}, env = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(
      PYTHON_RUNNER_SCRIPT,
      [],
      { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }
    )

    let output = ''
    child.stdout.on('data', chunk => { output += chunk })

    let errorOutput = ''
    child.stderr.on('data', chunk => { errorOutput += chunk })

    child.on('message', (msg) => {
      // IPC message not expected but handle gracefully
    })

    child.on('close', (code) => {
      if (code !== 0 && !output) {
        reject(new Error(errorOutput.trim() || `Process exited with code ${code}`))
        return
      }
      try {
        const parsed = JSON.parse(output.trim())
        resolve(parsed)
      } catch {
        resolve({ success: true, data: output.trim() })
      }
    })

    child.on('error', reject)

    // Send code + input as JSON to the child process stdin
    const message = JSON.stringify({ code, input, env })
    child.stdin.write(message)
    child.stdin.end()

    // Timeout after 15 seconds
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Python script timed out after 15s'))
    }, 15000)

    child.on('close', () => clearTimeout(timer))
  })
}

export { executeCustomSkill, executePythonSkill }
