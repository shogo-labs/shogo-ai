/**
 * Shogo SDK Error Classes
 */

export type ShogoErrorCode =
  | 'UNKNOWN'
  | 'NETWORK_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  // Auth-specific
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_USER_EXISTS'
  | 'AUTH_USER_NOT_FOUND'
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_INVALID_TOKEN'
  // Database-specific
  | 'DB_ENTITY_NOT_FOUND'
  | 'DB_QUERY_ERROR'
  | 'DB_CONSTRAINT_VIOLATION'

export class ShogoError extends Error {
  readonly code: ShogoErrorCode
  readonly status?: number
  readonly details?: unknown

  constructor(
    message: string,
    code: ShogoErrorCode = 'UNKNOWN',
    status?: number,
    details?: unknown
  ) {
    super(message)
    this.name = 'ShogoError'
    this.code = code
    this.status = status
    this.details = details

    // Maintain proper stack trace in V8
    if ('captureStackTrace' in Error) {
      ;(Error as unknown as { captureStackTrace: (err: Error, fn: Function) => void }).captureStackTrace(this, ShogoError)
    }
  }

  static fromStatus(status: number, message?: string, details?: unknown): ShogoError {
    const codeMap: Record<number, ShogoErrorCode> = {
      400: 'VALIDATION_ERROR',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      429: 'RATE_LIMITED',
      500: 'SERVER_ERROR',
    }

    const code = codeMap[status] || 'UNKNOWN'
    const defaultMessage = message || `Request failed with status ${status}`

    return new ShogoError(defaultMessage, code, status, details)
  }

  static networkError(message: string, details?: unknown): ShogoError {
    return new ShogoError(message, 'NETWORK_ERROR', undefined, details)
  }

  static unauthorized(message = 'Unauthorized'): ShogoError {
    return new ShogoError(message, 'UNAUTHORIZED', 401)
  }

  static notFound(message = 'Not found'): ShogoError {
    return new ShogoError(message, 'NOT_FOUND', 404)
  }

  static validationError(message: string, details?: unknown): ShogoError {
    return new ShogoError(message, 'VALIDATION_ERROR', 400, details)
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      details: this.details,
    }
  }
}

export class AuthError extends ShogoError {
  constructor(
    message: string,
    code: ShogoErrorCode = 'UNAUTHORIZED',
    details?: unknown
  ) {
    super(message, code, code === 'UNAUTHORIZED' ? 401 : undefined, details)
    this.name = 'AuthError'
  }

  static invalidCredentials(): AuthError {
    return new AuthError(
      'Invalid email or password',
      'AUTH_INVALID_CREDENTIALS'
    )
  }

  static userExists(email: string): AuthError {
    return new AuthError(
      `User with email ${email} already exists`,
      'AUTH_USER_EXISTS'
    )
  }

  static sessionExpired(): AuthError {
    return new AuthError(
      'Session has expired. Please sign in again.',
      'AUTH_SESSION_EXPIRED'
    )
  }

  static invalidToken(): AuthError {
    return new AuthError(
      'Invalid or expired token',
      'AUTH_INVALID_TOKEN'
    )
  }
}

export class DatabaseError extends ShogoError {
  constructor(
    message: string,
    code: ShogoErrorCode = 'DB_QUERY_ERROR',
    details?: unknown
  ) {
    super(message, code, undefined, details)
    this.name = 'DatabaseError'
  }

  static entityNotFound(model: string, id: string): DatabaseError {
    return new DatabaseError(
      `${model} with id '${id}' not found`,
      'DB_ENTITY_NOT_FOUND'
    )
  }

  static queryError(message: string, details?: unknown): DatabaseError {
    return new DatabaseError(message, 'DB_QUERY_ERROR', details)
  }
}
