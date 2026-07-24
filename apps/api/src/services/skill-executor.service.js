// apps/api/src/services/skill-executor.service.js
import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNNER_SCRIPT = path.join(__dirname, 'skill-runner.mjs')

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
export async function executeCustomSkill(code, input = {}, env = {}) {
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
