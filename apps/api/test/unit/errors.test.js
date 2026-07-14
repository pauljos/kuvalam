// test/unit/errors.test.js
// Tests for AppError and errorResponse utility

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../../src/utils/errors.js'

test('AppError: sets all properties correctly', () => {
  const err = new AppError('NOT_FOUND', 'Resource not found', 404)
  assert.equal(err.code, 'NOT_FOUND')
  assert.equal(err.message, 'Resource not found')
  assert.equal(err.statusCode, 404)
  assert.equal(err.name, 'AppError')
  assert.ok(err instanceof Error)
  assert.ok(err instanceof AppError)
})

test('AppError: defaults statusCode to 400', () => {
  const err = new AppError('BAD_INPUT', 'Bad input')
  assert.equal(err.statusCode, 400)
})

test('AppError: is throwable and catchable', () => {
  assert.throws(
    () => { throw new AppError('FAIL', 'Something failed', 500) },
    (err) => err instanceof AppError && err.code === 'FAIL'
  )
})

test('AppError: stack trace is available', () => {
  const err = new AppError('TRACE_TEST', 'test')
  assert.ok(typeof err.stack === 'string')
  assert.ok(err.stack.includes('AppError') || err.stack.includes('errors.test'))
})

test('AppError: code 400 for missing required field', () => {
  const err = new AppError('REQUIRED_FIELD', 'Field is required', 400)
  assert.equal(err.statusCode, 400)
})

test('AppError: code 401 for authentication errors', () => {
  const err = new AppError('UNAUTHORIZED', 'Not authenticated', 401)
  assert.equal(err.statusCode, 401)
})

test('AppError: code 403 for authorization errors', () => {
  const err = new AppError('FORBIDDEN', 'Access denied', 403)
  assert.equal(err.statusCode, 403)
})

test('AppError: code 500 for server errors', () => {
  const err = new AppError('INTERNAL_ERROR', 'Unexpected error', 500)
  assert.equal(err.statusCode, 500)
})
