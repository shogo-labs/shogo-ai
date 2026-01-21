/**
 * Authorization Module - Public API
 *
 * Schema-driven authorization for query-level access control.
 *
 * @example
 * import {
 *   extractAuthorizationConfig,
 *   AuthorizationService,
 *   type IAuthContext
 * } from './authorization'
 *
 * const config = extractAuthorizationConfig(schema.$defs.Task)
 * const service = new AuthorizationService()
 * const filter = service.buildScopeFilter(authContext, config)
 */

// Types
export type {
  AuthorizationConfig,
  IAuthContext,
  IAuthorizationService
} from './types'

// Config extraction
export {
  extractAuthorizationConfig,
  extractAllAuthorizationConfigs
} from './extract-config'

// Service
export {
  AuthorizationService,
  authorizationService,
  determineTrustedMode,
  MEMBERSHIP_SCHEMA,
  MEMBERSHIP_MODEL
} from './auth-service'
