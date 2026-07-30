// apps/api/src/utils/responses.js
// Standardized response helpers for consistent API envelopes

/**
 * Standard success response
 * @param {object} reply - Fastify reply object
 * @param {any} data - Response data
 * @param {number} statusCode - HTTP status code (default 200)
 * @returns {object} Fastify reply
 */
export function successResponse(reply, data, statusCode = 200) {
  return reply.status(statusCode).send({
    success: true,
    data,
    meta: {
      requestId: reply.request?.id,
      timestamp: new Date().toISOString()
    }
  })
}

/**
 * Standard created response (201)
 * @param {object} reply - Fastify reply object
 * @param {any} data - Response data
 * @returns {object} Fastify reply
 */
export function createdResponse(reply, data) {
  return successResponse(reply, data, 201)
}

/**
 * Standard accepted response (202) - for async operations
 * @param {object} reply - Fastify reply object
 * @param {any} data - Response data
 * @returns {object} Fastify reply
 */
export function acceptedResponse(reply, data) {
  return successResponse(reply, data, 202)
}

/**
 * Standard no content response (204)
 * @param {object} reply - Fastify reply object
 * @returns {object} Fastify reply
 */
export function noContentResponse(reply) {
  return reply.status(204).send()
}
