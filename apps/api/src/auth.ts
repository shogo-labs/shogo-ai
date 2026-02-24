/**
 * Better Auth Server Configuration
 * Task: task-ba-006, task-org-002
 *
 * Configures Better Auth with:
 * - PostgreSQL database via pg Pool from DATABASE_URL
 * - Uses Prisma-managed tables (users, sessions, accounts, verifications)
 * - Email/password authentication (no email verification required)
 * - JWT sessions with 7-day expiry
 * - Google OAuth social provider
 * - Trusted origins for CORS
 * - Database hooks for auto-creating personal workspace on signup
 */

import { betterAuth } from "better-auth"
import { Pool } from "pg"
import { createPersonalWorkspace } from "./services/workspace.service"
import { sendWelcomeEmail } from "./services/email.service"

/**
 * Strip HTML tags and angle brackets from user input.
 * Server-side safety net against XSS — even if client-side validation is bypassed,
 * no HTML/script content will be stored in the database.
 */
function sanitizeName(name: string | undefined | null): string {
  if (!name) return ""
  return name
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim()
}

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

  // User model configuration - uses Prisma's users table
  user: {
    modelName: "users",
    fields: {
      emailVerified: "emailVerified",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  },

  // Session model configuration - uses Prisma's sessions table
  session: {
    modelName: "sessions",
    fields: {
      userId: "userId",
      expiresAt: "expiresAt",
      ipAddress: "ipAddress",
      userAgent: "userAgent",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    // JWT session with 7-day expiry (in seconds)
    expiresIn: 60 * 60 * 24 * 7,
    // Cookie cache to reduce database queries on repeated get-session calls
    // This stores session data in a short-lived signed cookie, avoiding
    // database lookups for each useSession() call in React StrictMode
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // Cache for 5 minutes
    },
  },

  // Account model configuration - uses Prisma's accounts table
  account: {
    modelName: "accounts",
    fields: {
      userId: "userId",
      accountId: "accountId",
      providerId: "providerId",
      accessToken: "accessToken",
      refreshToken: "refreshToken",
      accessTokenExpiresAt: "accessTokenExpiresAt",
      refreshTokenExpiresAt: "refreshTokenExpiresAt",
      idToken: "idToken",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  },

  // Verification model configuration - uses Prisma's verifications table
  verification: {
    modelName: "verifications",
    fields: {
      expiresAt: "expiresAt",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
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

  trustedOrigins: (request) => {
    const origins = [...getAllowedOrigins()]
    if (process.env.NODE_ENV !== 'production') {
      const reqOrigin = request?.headers?.get?.('origin')
      if (reqOrigin?.startsWith('http://localhost:') && !origins.includes(reqOrigin)) {
        origins.push(reqOrigin)
      }
    }
    return origins
  },

  // Advanced configuration
  advanced: {
    database: {
      // Generate UUIDs for all BetterAuth tables to match our frontend schema
      generateId: (options) => crypto.randomUUID(),
    },
  },

  // Database hooks for auto-creating personal workspace on user signup
  // Task: task-org-002
  databaseHooks: {
    user: {
      create: {
        /**
         * Before creating a user, sanitize the name to prevent stored XSS.
         * Strips any HTML tags and angle brackets from the name field.
         */
        before: async (user) => {
          if (user.name) {
            user.name = sanitizeName(user.name)
          }
          return { data: user }
        },
        /**
         * After a new user is created, automatically create their personal workspace.
         * This ensures every user has at least one workspace to work in immediately after signup.
         *
         * Uses Prisma-based workspace service.
         *
         * Errors are logged but do not block user creation (graceful degradation).
         */
        after: async (user) => {
          try {
            // BLOCKING: Create workspace (user needs this immediately)
            await createPersonalWorkspace(user.id, user.name || "User")
            console.log(`Created personal workspace for user ${user.email}`)
            
            // FIRE-AND-FORGET: Send welcome email (non-blocking)
            const baseUrl = process.env.APP_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3001'
            sendWelcomeEmail({
              to: user.email,
              name: user.name || 'User',
              loginUrl: `${baseUrl}/login`
            }).catch((err) => {
              // Gracefully log email failures without blocking
              console.error(`Welcome email failed for ${user.email}:`, err)
            })
            
          } catch (error) {
            // Log error but don't block user creation
            console.error(
              `Failed to create personal workspace for user ${user.email}:`,
              error instanceof Error ? error.message : String(error)
            )
          }
        },
      },
      update: {
        /**
         * Before updating a user, sanitize the name to prevent stored XSS.
         * This covers profile name changes via settings pages.
         */
        before: async (user) => {
          if (user.name) {
            user.name = sanitizeName(user.name)
          }
          return { data: user }
        },
      },
    },
  },
})

// Export the Auth type for use in route handlers
export type Auth = typeof auth
