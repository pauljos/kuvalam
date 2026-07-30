#!/usr/bin/env node
// Python skill runner — executes Python snippets in a subprocess
// Receives JSON on stdin: { code: string, input: any, env: Record<string,string> }
// Writes JSON result to stdout

import { spawn } from 'child_process'

function main() {
  let data = ''
  process.stdin.on('data', chunk => { data += chunk })
  process.stdin.on('end', async () => {
    try {
      const { code, input, env } = JSON.parse(data)

      // Build a Python script that reads input from stdin, executes the user code, and prints result as JSON
      const wrapper = `
import json, sys, traceback

# Read input data
input_data = json.loads(sys.stdin.readline())

# User code follows
${code}

# After user code, capture the result
# The user code should define a variable called 'result'
# If no 'result' variable, try to get the last expression
try:
    result
except NameError:
    # Try to capture anything the user printed
    result = {"_note": "No 'result' variable defined. Define a 'result' variable to return data."}

print("___PYTHON_RESULT___")
print(json.dumps(result))
`
      const envObj = { ...process.env, ...env, PYTHONUNBUFFERED: '1' }
      const child = spawn('python3', ['-c', wrapper], {
        env: envObj,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      })

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })

      // Send input data on stdin
      child.stdin.write(JSON.stringify(input || {}))
      child.stdin.end()

      child.on('close', (code) => {
        if (code !== 0) {
          process.stdout.write(JSON.stringify({ success: false, error: stderr.trim() || `Exit code ${code}` }))
          return
        }
        // Extract result between markers
        const match = stdout.match(/___PYTHON_RESULT___\n([\s\S]*)/)
        if (match) {
          try {
            const result = JSON.parse(match[1].trim())
            process.stdout.write(JSON.stringify({ success: true, data: result }))
          } catch {
            process.stdout.write(JSON.stringify({ success: true, data: match[1].trim() }))
          }
        } else {
          process.stdout.write(JSON.stringify({ success: true, data: stdout.trim() }))
        }
      })
    } catch (err) {
      process.stdout.write(JSON.stringify({ success: false, error: err.message }))
    }
  })
}

main()
