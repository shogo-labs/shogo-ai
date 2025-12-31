/**
 * Better Auth Server Configuration
 * Task: task-ba-006
 *
 * Configures Better Auth with:
 * - PostgreSQL database via pg Pool from DATABASE_URL
 * - Custom model names with better_auth_tables schema
 * - Field mappings for snake_case columns
 * - Email/password authentication (no email verification required)
 * - JWT sessions with 7-day expiry
 * - Google OAuth social provider
 * - Trusted origins for CORS
 */

import { betterAuth } from "better-auth"
import { Pool } from "pg"

// Port configuration from environment
const VITE_PORT = process.env.VITE_PORT || "5173"

export const auth = betterAuth({
  // Base URL for OAuth callbacks - must match Google's authorized redirect URIs
  baseURL: `http://localhost:${VITE_PORT}`,

  // PostgreSQL database connection via pg Pool
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),

  // User model configuration with schema-qualified name and field mappings
  user: {
    modelName: "better_auth_tables.user",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },

  // Session model configuration with field mappings
  session: {
    modelName: "better_auth_tables.session",
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
    modelName: "better_auth_tables.account",
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
    modelName: "better_auth_tables.verification",
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

  // Trusted origins for CORS - includes localhost with VITE_PORT
  trustedOrigins: [`http://localhost:${VITE_PORT}`],
})

// Export the Auth type for use in route handlers
export type Auth = typeof auth
