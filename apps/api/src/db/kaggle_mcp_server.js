// apps/api/src/db/kaggle_mcp_server.js
import http from 'http'
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

const execAsync = promisify(exec)
const PORT = 3005

const tools = [
  {
    name: 'kaggle_list_competitions',
    description: 'List active Kaggle competitions with their reference URLs, deadlines, and rewards.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term to filter competitions' }
      }
    }
  },
  {
    name: 'kaggle_download_files',
    description: 'Download train and test dataset files for a given Kaggle competition.',
    inputSchema: {
      type: 'object',
      properties: {
        competition: { type: 'string', description: 'The exact competition name/slug, e.g. titanic' }
      },
      required: ['competition']
    }
  },
  {
    name: 'kaggle_submit',
    description: 'Submit a predictions CSV file to a Kaggle competition.',
    inputSchema: {
      type: 'object',
      properties: {
        competition: { type: 'string', description: 'The competition name/slug' },
        file_path: { type: 'string', description: 'Absolute path to the submission CSV file' },
        message: { type: 'string', description: 'Description of the submission/model' }
      },
      required: ['competition', 'file_path', 'message']
    }
  }
]

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method Not Allowed' }))
    return
  }

  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body || '{}')
      const { method, params, id } = payload

      if (method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { tools }
        }))
        return
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = params
        let resultText = ''
        let isError = false

        try {
          if (name === 'kaggle_list_competitions') {
            const searchOpt = args.search ? `--search "${args.search}"` : ''
            const { stdout } = await execAsync(`kaggle competitions list ${searchOpt}`)
            resultText = stdout
          } else if (name === 'kaggle_download_files') {
            const comp = args.competition
            const destDir = `/Users/PaulJoseph/pgent/artifacts/kaggle/${comp}`
            fs.mkdirSync(destDir, { recursive: true })
            
            // Run download
            const { stdout } = await execAsync(`kaggle competitions download -c ${comp} -p "${destDir}"`)
            
            // Unzip if zip file is downloaded
            const files = fs.readdirSync(destDir)
            for (const f of files) {
              if (f.endsWith('.zip')) {
                const zipPath = path.join(destDir, f)
                await execAsync(`unzip -o "${zipPath}" -d "${destDir}"`)
                fs.unlinkSync(zipPath) // remove zip after extraction
              }
            }
            
            resultText = `Successfully downloaded and extracted files for ${comp} to ${destDir}.\nFiles: ${fs.readdirSync(destDir).join(', ')}`
          } else if (name === 'kaggle_submit') {
            const { competition, file_path, message } = args
            const { stdout } = await execAsync(`kaggle competitions submit -c ${competition} -f "${file_path}" -m "${message}"`)
            resultText = stdout
          } else {
            isError = true
            resultText = `Unknown tool: ${name}`
          }
        } catch (e) {
          isError = true
          resultText = `Error executing ${name}: ${e.message}\n${e.stderr || ''}`
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            isError,
            content: [{ type: 'text', text: resultText }]
          }
        }))
        return
      }

      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid Method' }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })
})

server.listen(PORT, () => {
  console.log(`📡 Kaggle MCP Server listening on port ${PORT}`)
})
