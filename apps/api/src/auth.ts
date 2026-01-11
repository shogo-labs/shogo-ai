/**
 * Better Auth Server Configuration
 * Task: task-ba-006, task-org-002
 *
 * Configures Better Auth with:
 * - PostgreSQL database via pg Pool from DATABASE_URL
 * - Custom model names with better_auth schema
 * - Field mappings for snake_case columns
 * - Email/password authentication (no email verification required)
 * - JWT sessions with 7-day expiry
 * - Google OAuth social provider
 * - Trusted origins for CORS
 * - Database hooks for auto-creating personal organization on signup (via MCP domain)
 */

import { betterAuth } from "better-auth"
import { Pool } from "pg"
import { studioCoreDomain } from "@shogo/state-api/studio-core/domain"
import { BunPostgresExecutor } from "@shogo/state-api/query/execution/bun-postgres"
import { createBackendRegistry } from "@shogo/state-api/query/registry"
import { SqlBackend } from "@shogo/state-api/query/backends/sql"
import { NullPersistence } from "@shogo/state-api/persistence/null"

// Port configuration from environment
const API_PORT = process.env.API_PORT || "8002"

// Base URL for Better Auth - use BETTER_AUTH_URL in production, localhost in dev
const getBaseURL = (): string => {
  if (process.env.BETTER_AUTH_URL) {
    return process.env.BETTER_AUTH_URL
  }
  return `http://localhost:${API_PORT}`
}

// CORS origins from environment - supports comma-separated list
// Defaults to localhost for development
const getAllowedOrigins = (): string[] => {
  const envOrigins = process.env.ALLOWED_ORIGINS
  if (envOrigins) {
    return envOrigins.split(',').map(o => o.trim())
  }
  // Default: localhost only (dev mode)
  return [`http://localhost:${API_PORT}`]
}

// Domain store singleton for database hooks (used to create personal orgs)
// Uses studioCoreDomain with PostgreSQL backend via backendRegistry
let domainStore: ReturnType<typeof studioCoreDomain.createStore> | null = null

async function getDomainStore(): Promise<ReturnType<typeof studioCoreDomain.createStore>> {
  if (domainStore) {
    return domainStore
  }

  const DATABASE_URL = process.env.DATABASE_URL
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required")
  }

  const isSupabase = DATABASE_URL.includes("supabase")
  const executor = new BunPostgresExecutor(DATABASE_URL, {
    tls: isSupabase,
    max: 5,
  })

  const registry = createBackendRegistry()
  const sqlBackend = new SqlBackend({ dialect: "pg", executor })
  registry.register("postgres", sqlBackend)
  registry.setDefault("postgres")

  domainStore = studioCoreDomain.createStore({
    services: {
      persistence: new NullPersistence(),
      backendRegistry: registry,
    },
    context: {
      schemaName: "studio-core",
    },
  })

  return domainStore
}

export const auth = betterAuth({
  // Base URL for OAuth callbacks - must match Google's authorized redirect URIs
  baseURL: getBaseURL(),

  // PostgreSQL database connection via pg Pool
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),

  // User model configuration with schema-qualified name and field mappings
  user: {
    modelName: "better_auth.user",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },

  // Session model configuration with field mappings
  session: {
    modelName: "better_auth.session",
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    // JWT session with 7-day expiry (in seconds)
    expiresIn: 60 * 60 * 24 * 7,
  },

  // Account model configuration with field mappings for OAuth providers
  account: {
    modelName: "better_auth.account",
    fields: {
      userId: "user_id",
      accountId: "account_id",
      providerId: "provider_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      idToken: "id_token",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },

  // Verification model configuration for email verification tokens
  verification: {
    modelName: "better_auth.verification",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },

  // Email and password authentication - enabled without email verification
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },

  // Social providers - Google OAuth
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },

  // Trusted origins for CORS - configured via ALLOWED_ORIGINS env var
  trustedOrigins: getAllowedOrigins(),

  // Database hooks for auto-creating personal organization on user signup
  // Task: task-org-002
  databaseHooks: {
    user: {
      create: {
        /**
         * After a new user is created, automatically create their personal organization.
         * This ensures every user has at least one org to work in immediately after signup.
         *
         * Uses studioCoreDomain.createPersonalOrganization() action via MCP domain layer.
         *
         * Errors are logged but do not block user creation (graceful degradation).
         */
        after: async (user) => {
          try {
            const store = await getDomainStore()
            await store.createPersonalOrganization(user.id, user.name || "User")
            console.log(`Created personal org for user ${user.email}`)
          } catch (error) {
            // Log error but don't block user creation
            console.error(
              `Failed to create personal org for user ${user.email}:`,
              error instanceof Error ? error.message : String(error)
            )
          }
        },
      },
    },
  },
})

// Export the Auth type for use in route handlers
export type Auth = typeof auth
