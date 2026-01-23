/**
 * BetterAuth Module Exports
 *
 * Re-exports all better-auth related types, schema, services, and domain store.
 */

// Types (interface contract)
export type {
  BetterAuthUser,
  BetterAuthSession,
  BetterAuthAccount,
  IBetterAuthService,
} from "./types"

// Schema (auto-generated from Prisma)
export { BetterAuthScope, BetterAuthScope as BetterAuthSchema } from "../generated/better-auth.schema"

// Domain store
export { betterAuthDomain, createBetterAuthStore } from "./domain"
export type { CreateBetterAuthStoreOptions } from "./domain"

// Services
export { BetterAuthService } from "./service"
export type { BetterAuthServiceConfig } from "./service"
