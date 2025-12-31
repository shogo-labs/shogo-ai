/**
 * Tests for BetterAuth module exports
 *
 * Verifies that index.ts properly re-exports all public API:
 * - Types from ./types
 * - Schema from ./schema
 * - Domain from ./domain
 * - Service from ./service
 *
 * Task: task-ba-005
 */

import { describe, test, expect } from "bun:test"

describe("better-auth index exports", () => {
  /**
   * Test: Types are exported
   * Verifies that all type exports from ./types are re-exported
   */
  test("exports types from ./types", async () => {
    const mod = await import("../index")

    // IBetterAuthService should be a type export (not directly testable at runtime)
    // BetterAuthUser, BetterAuthSession, BetterAuthAccount should be type exports
    // We verify the module can be imported without errors
    expect(mod).toBeDefined()
  })

  /**
   * Test: Schema is exported
   * Verifies that BetterAuthSchema from ./schema is re-exported
   */
  test("exports BetterAuthSchema from ./schema", async () => {
    const mod = await import("../index")

    expect(mod.BetterAuthSchema).toBeDefined()
    // Verify it's an ArkType scope by checking for expected properties
    expect(typeof mod.BetterAuthSchema).toBe("object")
  })

  /**
   * Test: Domain exports are available
   * Verifies betterAuthDomain and createBetterAuthStore are exported
   */
  test("exports betterAuthDomain and createBetterAuthStore from ./domain", async () => {
    const mod = await import("../index")

    expect(mod.betterAuthDomain).toBeDefined()
    expect(typeof mod.betterAuthDomain).toBe("object")
    expect(mod.betterAuthDomain.name).toBe("better-auth")

    expect(mod.createBetterAuthStore).toBeDefined()
    expect(typeof mod.createBetterAuthStore).toBe("function")
  })

  /**
   * Test: Service is exported
   * Verifies BetterAuthService class is exported
   */
  test("exports BetterAuthService from ./service", async () => {
    const mod = await import("../index")

    expect(mod.BetterAuthService).toBeDefined()
    expect(typeof mod.BetterAuthService).toBe("function") // class constructor
  })

  /**
   * Test: Service config type is exported
   * Verifies BetterAuthServiceConfig is available
   */
  test("exports BetterAuthServiceConfig type from ./service", async () => {
    // BetterAuthServiceConfig is a type, so we verify by using it
    const mod = await import("../index")

    // Can construct a service with the config shape
    const service = new mod.BetterAuthService({
      baseUrl: "http://localhost:3000",
    })
    expect(service).toBeDefined()
  })
})

describe("state-api index exports better-auth", () => {
  /**
   * Test: better-auth is exported from state-api root
   * Verifies packages/state-api/src/index.ts re-exports better-auth
   */
  test("state-api index re-exports better-auth module", async () => {
    const mod = await import("../../index")

    // All better-auth exports should be available from state-api root
    expect(mod.BetterAuthSchema).toBeDefined()
    expect(mod.betterAuthDomain).toBeDefined()
    expect(mod.createBetterAuthStore).toBeDefined()
    expect(mod.BetterAuthService).toBeDefined()
  })
})
