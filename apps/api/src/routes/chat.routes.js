import { createConversation, listConversations, getConversation, deleteConversation, updateConversation, addMessage, getMessages, streamChatResponse } from '../services/chat.service.js'
import { query } from '../db/pool.js'

export default async function (fastify, opts) {

  // List conversations for a user
  fastify.get('/tenants/:tenantId/chat/conversations', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId } = request.params
    const userId = request.user.sub
    const conversations = await listConversations(tenantId, userId)
    return { success: true, data: { conversations } }
  })

  // Create new conversation
  fastify.post('/tenants/:tenantId/chat/conversations', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['model', 'provider'],
        properties: {
          title: { type: 'string' },
          model: { type: 'string' },
          provider: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { tenantId } = request.params
    const userId = request.user.sub
    const { title, model, provider } = request.body
    const conversation = await createConversation({ tenantId, userId, title, model, provider })
    return { success: true, data: { conversation } }
  })

  // Get conversation by ID
  fastify.get('/tenants/:tenantId/chat/conversations/:conversationId', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, conversationId } = request.params
    const userId = request.user.sub
    const conversation = await getConversation(tenantId, conversationId, userId)
    return { success: true, data: { conversation } }
  })

  // Delete conversation
  fastify.delete('/tenants/:tenantId/chat/conversations/:conversationId', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, conversationId } = request.params
    const userId = request.user.sub
    await deleteConversation(tenantId, conversationId, userId)
    return { success: true }
  })

  // Rename conversation
  fastify.patch('/tenants/:tenantId/chat/conversations/:conversationId', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 }
        }
      }
    }
  }, async (request, reply) => {
    const { tenantId, conversationId } = request.params
    const userId = request.user.sub
    const conversation = await updateConversation(tenantId, conversationId, userId, { title: request.body.title })
    return { success: true, data: { conversation } }
  })

  // Get messages in a conversation
  fastify.get('/tenants/:tenantId/chat/conversations/:conversationId/messages', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, conversationId } = request.params
    const userId = request.user.sub
    await getConversation(tenantId, conversationId, userId)
    const messages = await getMessages(conversationId)
    return { success: true, data: { messages } }
  })

  // Send a message
  fastify.post('/tenants/:tenantId/chat/conversations/:conversationId/messages', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string' },
          knowledgeBaseIds: {
            type: 'array',
            items: { type: 'string' }
          },
          graphIds: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { tenantId, conversationId } = request.params
    const userId = request.user.sub
    const { content, knowledgeBaseIds, graphIds } = request.body

    // Verify conversation ownership
    const conversation = await getConversation(tenantId, conversationId, userId)

    // Save user message
    await addMessage({
      conversationId,
      role: 'user',
      content,
      model: conversation.model
    })

    // Get conversation history
    const history = await getMessages(conversationId)
    const messages = history.map(m => ({ role: m.role, content: m.content }))

    // Get LLM config for the tenant
    const { rows } = await query(
      'SELECT llm_config FROM tenants WHERE id = $1',
      [tenantId]
    )
    const llmConfig = rows[0]?.llm_config || {}

    try {
      // Get response from LLM
      const response = await streamChatResponse({
        tenantId,
        userId,
        conversationId,
        messages,
        model: conversation.model,
        provider: conversation.provider,
        llmConfig,
        knowledgeBaseIds: knowledgeBaseIds?.length ? knowledgeBaseIds : null,
        graphIds: graphIds?.length ? graphIds : null,
        onToken: () => {} // No streaming callback for now
      })

      return { success: true, data: { message: response } }
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { message: err.message }
      })
    }
  })
}
