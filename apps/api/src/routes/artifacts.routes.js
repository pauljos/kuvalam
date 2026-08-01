// apps/api/src/routes/artifacts.routes.js
// Serves agent-generated artifact files (SVG, CSV, JSON, PNG, ZIP, etc.)
// stored under the workspace-level artifacts/ directory.
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { errorResponse } from '../utils/errors.js'

import { fileURLToPath } from 'url'
import { dirname } from 'path'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ts = () => ({ requestId: undefined, timestamp: new Date().toISOString() })

export default async function artifactsRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // GET /api/v1/artifacts/:tenantId/:filename
  fastify.get('/artifacts/:tenantId/:filename', auth, async (request, reply) => {
    try {
      const { tenantId, filename } = request.params

      // Resolve to workspace-level artifacts/<tenantId>/<date>/<filename>
      // We serve from the artifacts root, scanning date folders for the file
      const artifactsRoot = resolve(__dirname, '..', '..', '..', '..', 'artifacts', tenantId)

      if (!existsSync(artifactsRoot)) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'No artifacts for this tenant' }, meta: ts(request) })
      }

      // Sanitise filename to prevent directory traversal
      const safeName = filename.replace(/\.\.\//g, '').replace(/\\/g, '/').split('/').pop()
      if (!safeName || safeName.includes('..')) {
        return reply.status(400).send({ success: false, error: { code: 'INVALID_FILENAME', message: 'Invalid filename' }, meta: ts(request) })
      }

      // Search through date subfolders for the file (newest first)
      const { readdir } = await import('fs/promises')
      const dateDirs = (await readdir(artifactsRoot, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
        .reverse()

      let filePath = null
      for (const dir of dateDirs) {
        const candidate = join(artifactsRoot, dir, safeName)
        if (existsSync(candidate)) {
          filePath = candidate
          break
        }
      }

      if (!filePath) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Artifact not found' }, meta: ts(request) })
      }

      // Determine content type
      const ext = safeName.split('.').pop()?.toLowerCase()
      const contentTypes = {
        svg: 'image/svg+xml',
        csv: 'text/csv',
        json: 'application/json',
        png: 'image/png',
        pdf: 'application/pdf',
        html: 'text/html',
        zip: 'application/zip',
      }
      const contentType = contentTypes[ext] || 'application/octet-stream'

      // For inline display of SVGs and HTML
      const disposition = ['svg', 'html', 'csv', 'json'].includes(ext) ? 'inline' : 'attachment'

      const content = await readFile(filePath)
      reply.header('Content-Type', contentType)
      reply.header('Content-Disposition', `${disposition}; filename="${safeName}"`)
      return reply.send(content)
    } catch (err) {
      return errorResponse(reply, err)
    }
  })
}
