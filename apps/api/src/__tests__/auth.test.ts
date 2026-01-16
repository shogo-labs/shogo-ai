/**
 * Tests for Better Auth server configuration
 * Task: task-ba-006
 *
 * Tests verify that the Better Auth server is configured correctly with:
 * - PostgreSQL database via pg Pool
 * - Custom model names with better_auth schema
 * - Field mappings for snake_case columns
 * - Email/password authentication
 * - JWT sessions with 7-day expiry
 * - Google OAuth social provider
 * - Trusted origins for CORS
 */

import { describe, test, expect, beforeAll } from "bun:test"

// We'll import the auth config - this will fail until auth.ts is created
let auth: any
let authModule: any

beforeAll(async () => {
  try {
    authModule = await import("../auth")
    auth = authModule.auth
  } catch (error) {
    // Module doesn't exist yet - tests will fail appropriately
    auth = null
    authModule = null
  }
})

describe("Better Auth Server Configuration", () => {
  // test-ba-006-01: Database configuration
  describe("Database Configuration", () => {
    test("auth module exports auth object", () => {
      expect(authModule).not.toBeNull()
      expect(auth).not.toBeNull()
      expect(auth).toBeDefined()
    })

    test("Auth type is exported (verified via TypeScript)", () => {
      // TypeScript type exports are erased at runtime
      // The type export is verified by TypeScript compilation
      // Here we just verify the auth object exists and has the expected shape
      expect(auth).toBeDefined()
      expect(auth.options).toBeDefined()
    })
  })

  // test-ba-006-02: User model configuration
  describe("User Model Configuration", () => {
    test("user modelName is 'better_auth.user'", () => {
      expect(auth.options.user?.modelName).toBe("better_auth.user")
    })

    test("emailVerified field maps to email_verified", () => {
      expect(auth.options.user?.fields?.emailVerified).toBe("email_verified")
    })

    test("createdAt field maps to created_at", () => {
      expect(auth.options.user?.fields?.createdAt).toBe("created_at")
    })

    test("updatedAt field maps to updated_at", () => {
      expect(auth.options.user?.fields?.updatedAt).toBe("updated_at")
    })
  })

  // test-ba-006-03: Session model configuration
  describe("Session Model Configuration", () => {
    test("session modelName is 'better_auth.session'", () => {
      expect(auth.options.session?.modelName).toBe("better_auth.session")
    })

    test("userId field maps to user_id", () => {
      expect(auth.options.session?.fields?.userId).toBe("user_id")
    })

    test("expiresAt field maps to expires_at", () => {
      expect(auth.options.session?.fields?.expiresAt).toBe("expires_at")
    })

    test("ipAddress field maps to ip_address", () => {
      expect(auth.options.session?.fields?.ipAddress).toBe("ip_address")
    })

    test("userAgent field maps to user_agent", () => {
      expect(auth.options.session?.fields?.userAgent).toBe("user_agent")
    })

    test("createdAt field maps to created_at", () => {
      expect(auth.options.session?.fields?.createdAt).toBe("created_at")
    })

    test("updatedAt field maps to updated_at", () => {
      expect(auth.options.session?.fields?.updatedAt).toBe("updated_at")
    })
  })

  // test-ba-006-04: Account model configuration
  describe("Account Model Configuration", () => {
    test("account modelName is 'better_auth.account'", () => {
      expect(auth.options.account?.modelName).toBe("better_auth.account")
    })

    test("userId field maps to user_id", () => {
      expect(auth.options.account?.fields?.userId).toBe("user_id")
    })

    test("accountId field maps to account_id", () => {
      expect(auth.options.account?.fields?.accountId).toBe("account_id")
    })

    test("providerId field maps to provider_id", () => {
      expect(auth.options.account?.fields?.providerId).toBe("provider_id")
    })

    test("accessToken field maps to access_token", () => {
      expect(auth.options.account?.fields?.accessToken).toBe("access_token")
    })

    test("refreshToken field maps to refresh_token", () => {
      expect(auth.options.account?.fields?.refreshToken).toBe("refresh_token")
    })

    test("accessTokenExpiresAt field maps to access_token_expires_at", () => {
      expect(auth.options.account?.fields?.accessTokenExpiresAt).toBe("access_token_expires_at")
    })

    test("refreshTokenExpiresAt field maps to refresh_token_expires_at", () => {
      expect(auth.options.account?.fields?.refreshTokenExpiresAt).toBe("refresh_token_expires_at")
    })

    test("createdAt field maps to created_at", () => {
      expect(auth.options.account?.fields?.createdAt).toBe("created_at")
    })

    test("updatedAt field maps to updated_at", () => {
      expect(auth.options.account?.fields?.updatedAt).toBe("updated_at")
    })
  })

  // test-ba-006-05: Verification model configuration
  describe("Verification Model Configuration", () => {
    test("verification modelName is 'better_auth.verification'", () => {
      expect(auth.options.verification?.modelName).toBe("better_auth.verification")
    })

    test("expiresAt field maps to expires_at", () => {
      expect(auth.options.verification?.fields?.expiresAt).toBe("expires_at")
    })

    test("createdAt field maps to created_at", () => {
      expect(auth.options.verification?.fields?.createdAt).toBe("created_at")
    })

    test("updatedAt field maps to updated_at", () => {
      expect(auth.options.verification?.fields?.updatedAt).toBe("updated_at")
    })
  })

  // test-ba-006-05: emailAndPassword configuration
  describe("Email and Password Configuration", () => {
    test("emailAndPassword is enabled", () => {
      expect(auth.options.emailAndPassword?.enabled).toBe(true)
    })

    test("requireEmailVerification is false", () => {
      expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(false)
    })
  })

  // test-ba-006-06: Session expiry configuration
  describe("Session Configuration", () => {
    test("session expiresIn is 604800 (7 days in seconds)", () => {
      expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24 * 7)
    })
  })

  // test-ba-006-07: Google OAuth configuration
  describe("Google OAuth Configuration", () => {
    test("socialProviders.google is configured", () => {
      expect(auth.options.socialProviders?.google).toBeDefined()
    })

    test("google clientId property exists in config", () => {
      // The config references process.env.GOOGLE_CLIENT_ID
      // In production, this will be set; in tests, it may be undefined
      // We verify the config structure exists
      expect(auth.options.socialProviders?.google).toHaveProperty("clientId")
    })

    test("google clientSecret property exists in config", () => {
      // The config references process.env.GOOGLE_CLIENT_SECRET
      // In production, this will be set; in tests, it may be undefined
      // We verify the config structure exists
      expect(auth.options.socialProviders?.google).toHaveProperty("clientSecret")
    })
  })

  // test-ba-006-08: trustedOrigins configuration
  describe("Trusted Origins Configuration", () => {
    test("trustedOrigins is an array", () => {
      expect(Array.isArray(auth.options.trustedOrigins)).toBe(true)
    })

    test("trustedOrigins includes localhost URL", () => {
      const origins = auth.options.trustedOrigins
      const hasLocalhost = origins.some((origin: string) =>
        origin.startsWith("http://localhost:")
      )
      expect(hasLocalhost).toBe(true)
    })
  })

  // test-org-002: Database hooks for auto-creating personal org
  describe("Database Hooks Configuration (test-org-002)", () => {
    test("databaseHooks is configured", () => {
      expect(auth.options.databaseHooks).toBeDefined()
    })

    test("databaseHooks.user is configured", () => {
      expect(auth.options.databaseHooks?.user).toBeDefined()
    })

    test("databaseHooks.user.create is configured", () => {
      expect(auth.options.databaseHooks?.user?.create).toBeDefined()
    })

    test("databaseHooks.user.create.after callback is defined", () => {
      expect(auth.options.databaseHooks?.user?.create?.after).toBeDefined()
      expect(typeof auth.options.databaseHooks?.user?.create?.after).toBe("function")
    })
  })
})
