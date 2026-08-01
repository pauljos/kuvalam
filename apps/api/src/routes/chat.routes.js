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

  // Clear all messages in a conversation (/reset command)
  fastify.delete('/tenants/:tenantId/chat/conversations/:conversationId/messages', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, conversationId } = request.params
    const userId = request.user.sub
    await getConversation(tenantId, conversationId, userId)
    await query('DELETE FROM chat_messages WHERE conversation_id = $1', [conversationId])
    return { success: true }
  })

  // Summarize conversation (/compact command)
  fastify.post('/tenants/:tenantId/chat/conversations/:conversationId/summarize', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const { tenantId, conversationId } = request.params
    const userId = request.user.sub
    const conversation = await getConversation(tenantId, conversationId, userId)
    const history = await getMessages(conversationId)
    if (history.length === 0) {
      return { success: true, data: { summary: 'No messages to summarize yet.' } }
    }
    const { rows } = await query('SELECT llm_config FROM tenants WHERE id = $1', [tenantId])
    try {
      const { complete } = await import('../services/llm.service.js')
      const convText = history.slice(-40).map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`
      ).join('\n\n')
      const result = await complete({
        tenantId,
        model: conversation.model,
        provider: conversation.provider,
        messages: [{ role: 'user', content: `Summarize this conversation in 3-4 concise sentences:\n\n${convText}` }],
        temperature: 0.3,
      })
      const summary = typeof result === 'string' ? result : result?.content || 'Could not summarize.'
      return { success: true, data: { summary } }
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: err.message } })
    }
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
          },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'contentBase64'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                contentBase64: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { tenantId, conversationId } = request.params
    const userId = request.user.sub
    const { content, knowledgeBaseIds, graphIds, attachments } = request.body

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
        attachments: attachments?.length ? attachments : null,
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
