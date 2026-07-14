// apps/api/src/routes/knowledge.routes.js
import * as knowledgeService from '../services/knowledge.service.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { fileTypeFromBuffer } from 'file-type'

// Whitelisted MIME types + extensions for knowledge document uploads
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc (older)
  'text/plain',
  'text/markdown',
  'text/csv'
])
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'txt', 'md', 'csv'])
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 50MB — matches multipart limit

export default async function knowledgeRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // POST /tenants/:tenantId/knowledge-bases
  fastify.post('/tenants/:tenantId/knowledge-bases', auth, async (req, reply) => {
    try {
      const kb = await knowledgeService.createKnowledgeBase({ tenantId: req.params.tenantId, ...req.body, userId: req.user.sub })
      return reply.status(201).send({ success: true, data: kb, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/knowledge-bases
  fastify.get('/tenants/:tenantId/knowledge-bases', auth, async (req, reply) => {
    try {
      const kbs = await knowledgeService.listKnowledgeBases(req.params.tenantId)
      return reply.send({ success: true, data: { knowledgeBases: kbs }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/knowledge-bases/:kbId
  fastify.get('/tenants/:tenantId/knowledge-bases/:kbId', auth, async (req, reply) => {
    try {
      const kb = await knowledgeService.getKnowledgeBase(req.params.tenantId, req.params.kbId)
      return reply.send({ success: true, data: kb, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/knowledge-bases/:kbId/documents — text/URL ingestion
  fastify.post('/tenants/:tenantId/knowledge-bases/:kbId/documents', auth, async (req, reply) => {
    try {
      const { name, content, sourceType } = req.body
      const result = await knowledgeService.ingestDocument({
        tenantId: req.params.tenantId,
        knowledgeBaseId: req.params.kbId,
        name, content,
        userId: req.user.sub
      })
      return reply.status(202).send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/knowledge-bases/:kbId/documents/upload — file upload
  fastify.post('/tenants/:tenantId/knowledge-bases/:kbId/documents/upload', auth, async (req, reply) => {
    try {
      const data = await req.file()
      if (!data) return reply.status(400).send({ success: false, error: { code: 'NO_FILE', message: 'No file uploaded' } })

      // Extension check — cheap, first line of defence
      const rawName = data.filename || ''
      const ext = rawName.split('.').pop()?.toLowerCase() || ''
      if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
        throw new AppError('INVALID_FILE_TYPE',
          `File extension .${ext} is not allowed. Allowed: ${[...ALLOWED_UPLOAD_EXTENSIONS].join(', ')}`, 400)
      }

      // Sanitise the filename to defeat path traversal (we never write it to disk,
      // but downstream code may log or return it).
      const safeName = rawName.replace(/[/\\]/g, '_').slice(0, 255)

      const chunks = []
      let received = 0
      for await (const chunk of data.file) {
        received += chunk.length
        if (received > MAX_UPLOAD_BYTES) {
          throw new AppError('FILE_TOO_LARGE', `File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`, 413)
        }
        chunks.push(chunk)
      }
      const fileBuffer = Buffer.concat(chunks)

      // Server-side MIME sniff — never trust client-provided mimetype.
      // Plain-text formats (.txt, .md, .csv) don't have magic bytes; skip detection for those.
      const isTextLike = ['txt', 'md', 'csv'].includes(ext)
      let effectiveMime = data.mimetype
      if (!isTextLike) {
        const detected = await fileTypeFromBuffer(fileBuffer)
        if (!detected || !ALLOWED_UPLOAD_MIME_TYPES.has(detected.mime)) {
          throw new AppError('INVALID_FILE_CONTENT',
            'File content does not match its declared type. Upload rejected.', 400)
        }
        effectiveMime = detected.mime
      } else if (!ALLOWED_UPLOAD_MIME_TYPES.has(effectiveMime || '')) {
        // For text formats, at least verify the client-declared MIME is an allowed one.
        effectiveMime = 'text/plain'
      }

      const result = await knowledgeService.ingestFile({
        tenantId: req.params.tenantId,
        knowledgeBaseId: req.params.kbId,
        filename: safeName,
        fileBuffer,
        mimeType: effectiveMime,
        userId: req.user.sub
      })
      return reply.status(202).send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/knowledge-bases/:kbId/documents
  fastify.get('/tenants/:tenantId/knowledge-bases/:kbId/documents', auth, async (req, reply) => {
    try {
      const docs = await knowledgeService.listDocuments(req.params.tenantId, req.params.kbId)
      return reply.send({ success: true, data: { documents: docs }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/knowledge-bases/:kbId/documents/:docId
  fastify.get('/tenants/:tenantId/knowledge-bases/:kbId/documents/:docId', auth, async (req, reply) => {
    try {
      const doc = await knowledgeService.getDocument(req.params.tenantId, req.params.docId)
      return reply.send({ success: true, data: doc, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/knowledge-bases/:kbId/search — test search
  fastify.post('/tenants/:tenantId/knowledge-bases/:kbId/search', auth, async (req, reply) => {
    try {
      const { query, strategy = 'HYBRID', topK = 10, threshold = 0.5 } = req.body
      const chunks = await knowledgeService.searchKnowledge({
        tenantId: req.params.tenantId,
        query,
        knowledgeBaseIds: [req.params.kbId],
        topK,
        threshold
      })
      return reply.send({ success: true, data: { chunks, count: chunks.length }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })
}

const ts = () => ({ timestamp: new Date().toISOString() })
