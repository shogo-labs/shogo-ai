/**
 * Auth Module Exports
 *
 * Re-exports all auth-related types, services, and domain store.
 */

// Types (interface contract)
export type {
  IAuthService,
  AuthCredentials,
  AuthUser,
  AuthSession,
  AuthError,
} from "./types"

// Services
export { MockAuthService } from "./mock"
export type { MockAuthServiceOptions } from "./mock"
export { SupabaseAuthService } from "./supabase"

// Domain store
export { AuthDomain, authDomain, createAuthStore } from "./domain"
export type { CreateAuthStoreOptions } from "./domain"
