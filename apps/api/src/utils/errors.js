// apps/api/src/utils/errors.js
export class AppError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.details = details
    this.name = 'AppError'
  }
}

export function errorResponse(reply, err) {
  const statusCode = err.statusCode || err.status || 500
  const code = err.code || 'INTERNAL_ERROR'
  const message = err.message || 'An unexpected error occurred'

  if (statusCode >= 500) {
    console.error('Server error:', err)
  }

  return reply.status(statusCode).send({
    success: false,
    error: { code, message, details: err.details || undefined },
    meta: { requestId: reply.request?.id, timestamp: new Date().toISOString() }
  })
}
