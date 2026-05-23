// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { ShogoError, AuthError, DatabaseError } from '../errors'

describe('ShogoError.fromStatus', () => {
  test('maps known HTTP statuses to ShogoErrorCode', () => {
    expect(ShogoError.fromStatus(400).code).toBe('VALIDATION_ERROR')
    expect(ShogoError.fromStatus(401).code).toBe('UNAUTHORIZED')
    expect(ShogoError.fromStatus(403).code).toBe('FORBIDDEN')
    expect(ShogoError.fromStatus(404).code).toBe('NOT_FOUND')
    expect(ShogoError.fromStatus(409).code).toBe('CONFLICT')
    expect(ShogoError.fromStatus(429).code).toBe('RATE_LIMITED')
    expect(ShogoError.fromStatus(500).code).toBe('SERVER_ERROR')
  })

  test('falls back to UNKNOWN for unmapped statuses', () => {
    const e = ShogoError.fromStatus(418)
    expect(e.code).toBe('UNKNOWN')
    expect(e.status).toBe(418)
  })

  test('uses default message when none supplied', () => {
    const e = ShogoError.fromStatus(503)
    expect(e.message).toBe('Request failed with status 503')
  })

  test('preserves custom message and details', () => {
    const e = ShogoError.fromStatus(400, 'Bad payload', { field: 'email' })
    expect(e.message).toBe('Bad payload')
    expect(e.details).toEqual({ field: 'email' })
  })
})

describe('ShogoError factory helpers', () => {
  test('networkError', () => {
    const e = ShogoError.networkError('dns failed', { host: 'example.test' })
    expect(e.code).toBe('NETWORK_ERROR')
    expect(e.status).toBeUndefined()
    expect(e.details).toEqual({ host: 'example.test' })
  })

  test('unauthorized uses defaults', () => {
    const e = ShogoError.unauthorized()
    expect(e.code).toBe('UNAUTHORIZED')
    expect(e.status).toBe(401)
    expect(e.message).toBe('Unauthorized')
  })

  test('unauthorized with custom message', () => {
    expect(ShogoError.unauthorized('No token').message).toBe('No token')
  })

  test('notFound uses defaults', () => {
    const e = ShogoError.notFound()
    expect(e.code).toBe('NOT_FOUND')
    expect(e.status).toBe(404)
    expect(e.message).toBe('Not found')
  })

  test('notFound with custom message', () => {
    expect(ShogoError.notFound('Missing user').message).toBe('Missing user')
  })

  test('validationError', () => {
    const e = ShogoError.validationError('bad input', { fields: ['x'] })
    expect(e.code).toBe('VALIDATION_ERROR')
    expect(e.status).toBe(400)
    expect(e.details).toEqual({ fields: ['x'] })
  })
})

describe('ShogoError.toJSON', () => {
  test('serializes the canonical shape', () => {
    const e = new ShogoError('boom', 'SERVER_ERROR', 500, { traceId: 'abc' })
    expect(e.toJSON()).toEqual({
      name: 'ShogoError',
      message: 'boom',
      code: 'SERVER_ERROR',
      status: 500,
      details: { traceId: 'abc' },
    })
  })
})

describe('AuthError', () => {
  test('constructor maps UNAUTHORIZED to status 401', () => {
    const e = new AuthError('nope')
    expect(e.name).toBe('AuthError')
    expect(e.code).toBe('UNAUTHORIZED')
    expect(e.status).toBe(401)
  })

  test('constructor leaves non-UNAUTHORIZED status undefined', () => {
    const e = new AuthError('bad', 'AUTH_INVALID_TOKEN')
    expect(e.code).toBe('AUTH_INVALID_TOKEN')
    expect(e.status).toBeUndefined()
  })

  test('invalidCredentials', () => {
    const e = AuthError.invalidCredentials()
    expect(e.code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(e.message).toBe('Invalid email or password')
  })

  test('userExists includes the email', () => {
    const e = AuthError.userExists('a@b.test')
    expect(e.code).toBe('AUTH_USER_EXISTS')
    expect(e.message).toContain('a@b.test')
  })

  test('sessionExpired', () => {
    const e = AuthError.sessionExpired()
    expect(e.code).toBe('AUTH_SESSION_EXPIRED')
    expect(e.message).toContain('expired')
  })

  test('invalidToken', () => {
    const e = AuthError.invalidToken()
    expect(e.code).toBe('AUTH_INVALID_TOKEN')
  })
})

describe('DatabaseError', () => {
  test('constructor', () => {
    const e = new DatabaseError('query blew up')
    expect(e.name).toBe('DatabaseError')
    expect(e.code).toBe('DB_QUERY_ERROR')
    expect(e.status).toBeUndefined()
  })

  test('entityNotFound', () => {
    const e = DatabaseError.entityNotFound('User', 'usr-1')
    expect(e.code).toBe('DB_ENTITY_NOT_FOUND')
    expect(e.message).toBe("User with id 'usr-1' not found")
  })

  test('queryError', () => {
    const e = DatabaseError.queryError('bad sql', { sql: 'SELECT' })
    expect(e.code).toBe('DB_QUERY_ERROR')
    expect(e.details).toEqual({ sql: 'SELECT' })
  })
})
