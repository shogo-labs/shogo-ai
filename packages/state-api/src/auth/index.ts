/**
 * Auth module barrel export
 * Task: task-auth-006
 *
 * Re-exports all auth types, services, and domain store for clean imports:
 * import { IAuthService, MockAuthService, createAuthStore } from '@shogo/state-api/auth'
 */

// Types
export type {
  IAuthService,
  AuthUser,
  AuthSession,
  AuthResult,
} from "./types"

// Services
export { SupabaseAuthService, type SupabaseAuthClient } from "./supabase"
export { MockAuthService } from "./mock"

// Domain store
export { AuthDomain, createAuthStore } from "./domain"
