/**
 * Better Auth Server Configuration
 * Task: task-ba-006
 *
 * Configures Better Auth with:
 * - PostgreSQL database via pg Pool from DATABASE_URL
 * - Custom model names with better_auth schema
 * - Field mappings for snake_case columns
 * - Email/password authentication (no email verification required)
 * - JWT sessions with 7-day expiry
 * - Google OAuth social provider
 * - Trusted origins for CORS
 */

import { betterAuth } from "better-auth"
import { Pool } from "pg"

// Port configuration from environment
const API_PORT = process.env.API_PORT || "8002"
const VITE_PORT = process.env.VITE_PORT || "3000"

// Base URL for Better Auth - use BETTER_AUTH_URL in production, localhost in dev
// In dev with proxy setup, use VITE_PORT so OAuth callbacks route through the frontend proxy
const getBaseURL = (): string => {
  if (process.env.BETTER_AUTH_URL) {
    return process.env.BETTER_AUTH_URL
  }
  return `http://localhost:${VITE_PORT}`
}

// CORS origins from environment - supports comma-separated list
// Defaults to localhost for development
const getAllowedOrigins = (): string[] => {
  const envOrigins = process.env.ALLOWED_ORIGINS
  if (envOrigins) {
    return envOrigins.split(',').map(o => o.trim())
  }
  // Default: localhost only (dev mode) - use VITE_PORT since requests originate from frontend
  return [`http://localhost:${VITE_PORT}`]
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
})

// Export the Auth type for use in route handlers
export type Auth = typeof auth
