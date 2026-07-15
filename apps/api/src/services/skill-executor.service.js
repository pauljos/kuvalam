// apps/api/src/services/skill-executor.service.js
import vm from 'vm'

/**
 * Executes a custom JavaScript code snippet securely in a Node.js VM sandbox.
 * This is the foundation of Kuvalam NextGen Custom Code Skills.
 * 
 * @param {string} code - The custom JavaScript code to execute.
 * @param {Object} input - The input parameters provided by the LLM agent.
 * @param {Object} env - Any decrypted environment variables/secrets configured for the skill.
 * @returns {Promise<any>} The result of the code execution.
 */
export async function executeCustomSkill(code, input = {}, env = {}) {
  return new Promise(async (resolve, reject) => {
    // 1. Create a secure context
    // We explicitly provide standard utilities like fetch, so custom skills 
    // can make external API calls without having full Node.js fs/child_process access.
    const sandbox = {
      input,
      env,
      fetch,
      URL,
      URLSearchParams,
      Headers,
      console: {
        log: () => {},
        error: () => {},
        warn: () => {},
      },
      // We expose a resolve/reject to the sandbox to handle async completion natively
      __resolve: resolve,
      __reject: reject
    }

    vm.createContext(sandbox)

    // 2. Wrap the user code in an async IIFE
    // Users are expected to return their final output.
    const wrappedCode = `
      (async function() {
        try {
          // Provide a helper 'return' mechanic
          const result = await (async () => {
            ${code}
          })();
          __resolve(result);
        } catch (err) {
          __reject(err);
        }
      })();
    `

    // 3. Execute with strict limits
    try {
      const script = new vm.Script(wrappedCode, {
        filename: 'custom_skill.js'
      })

      script.runInContext(sandbox, {
        timeout: 5000, // Hard 5-second timeout to prevent infinite loops
        displayErrors: true
      })
    } catch (err) {
      reject(err)
    }
  })
}
