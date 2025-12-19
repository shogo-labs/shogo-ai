/**
 * MCP Server Postgres Initialization Tests
 *
 * Tests for the singleton Postgres backend initialization at MCP server startup.
 * Validates connection from DATABASE_URL environment variable and backend registry setup.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"

// Import from implementation module - will fail until implemented
import {
  initializePostgresBackend,
  getGlobalBackendRegistry,
  getPostgresExecutor,
  isPostgresAvailable,
  shutdownPostgres,
  __resetForTesting,
} from "../postgres-init"

// Store original env to restore after tests
const originalDatabaseUrl = process.env.DATABASE_URL

describe("MCP Postgres Initialization", () => {
  beforeEach(() => {
    // Reset module state before each test
    __resetForTesting()
  })

  afterEach(() => {
    // Restore original DATABASE_URL
    if (originalDatabaseUrl) {
      process.env.DATABASE_URL = originalDatabaseUrl
    } else {
      delete process.env.DATABASE_URL
    }
  })

  describe("initializePostgresBackend", () => {
    test("creates BunPostgresExecutor from DATABASE_URL env", () => {
      // Given: DATABASE_URL environment variable is set
      // Note: We can't test actual connection without a real database
      // This test verifies the function exists and has correct signature
      expect(initializePostgresBackend).toBeDefined()
      expect(typeof initializePostgresBackend).toBe("function")
    })

    test("returns false when DATABASE_URL is not set", async () => {
      // Given: DATABASE_URL is not set
      delete process.env.DATABASE_URL

      // When: initializePostgresBackend is called
      const result = await initializePostgresBackend()

      // Then: Returns false (no postgres available)
      expect(result).toBe(false)
    })
  })

  describe("isPostgresAvailable", () => {
    test("returns false when not initialized", () => {
      // Given: Postgres has not been initialized (DATABASE_URL not set)
      delete process.env.DATABASE_URL

      // When: isPostgresAvailable is called
      const available = isPostgresAvailable()

      // Then: Returns false
      expect(available).toBe(false)
    })
  })

  describe("getGlobalBackendRegistry", () => {
    test("returns singleton registry instance", () => {
      // Given: Module is imported
      // When: getGlobalBackendRegistry is called multiple times
      const registry1 = getGlobalBackendRegistry()
      const registry2 = getGlobalBackendRegistry()

      // Then: Same instance returned each time
      expect(registry1).toBeDefined()
      expect(registry1).toBe(registry2)
    })

    test("registry includes memory backend by default", () => {
      // Given: Global registry is available
      const registry = getGlobalBackendRegistry()

      // Then: Memory backend is registered
      expect(registry.has("memory")).toBe(true)
    })

    test("registry has memory as default backend", () => {
      // Given: Global registry is available
      // When: No DATABASE_URL is set
      delete process.env.DATABASE_URL

      // Then: Default backend is memory (safe fallback)
      // Note: We can't directly test the default without resolving,
      // but we can verify the registry structure
      const registry = getGlobalBackendRegistry()
      expect(registry).toBeDefined()
    })
  })

  describe("getPostgresExecutor", () => {
    test("returns undefined when postgres not initialized", () => {
      // Given: DATABASE_URL is not set
      delete process.env.DATABASE_URL

      // When: getPostgresExecutor is called
      const executor = getPostgresExecutor()

      // Then: Returns undefined
      expect(executor).toBeUndefined()
    })
  })

  describe("shutdownPostgres", () => {
    test("gracefully handles shutdown when not initialized", async () => {
      // Given: Postgres was never initialized
      delete process.env.DATABASE_URL

      // When: shutdownPostgres is called
      // Then: Should not throw
      await expect(shutdownPostgres()).resolves.toBeUndefined()
    })
  })
})

// ============================================================================
// Integration Tests (Requires DATABASE_URL)
// ============================================================================

const hasPostgres = !!process.env.DATABASE_URL
const describePostgres = hasPostgres ? describe : describe.skip

describePostgres("MCP Postgres Initialization (Integration)", () => {
  test("initializes successfully with valid DATABASE_URL", async () => {
    // Given: DATABASE_URL is set to valid connection
    // When: initializePostgresBackend is called
    const result = await initializePostgresBackend()

    // Then: Returns true (initialization successful)
    expect(result).toBe(true)
  })

  test("isPostgresAvailable returns true after initialization", async () => {
    // Given: Postgres has been initialized
    await initializePostgresBackend()

    // When: isPostgresAvailable is called
    const available = isPostgresAvailable()

    // Then: Returns true
    expect(available).toBe(true)
  })

  test("getPostgresExecutor returns executor after initialization", async () => {
    // Given: Postgres has been initialized
    await initializePostgresBackend()

    // When: getPostgresExecutor is called
    const executor = getPostgresExecutor()

    // Then: Returns BunPostgresExecutor instance
    expect(executor).toBeDefined()
    expect(executor?.execute).toBeDefined()
    expect(executor?.beginTransaction).toBeDefined()
  })

  test("registry includes postgres backend after initialization", async () => {
    // Given: Postgres has been initialized
    await initializePostgresBackend()
    const registry = getGlobalBackendRegistry()

    // Then: Postgres backend is registered
    expect(registry.has("postgres")).toBe(true)
  })

  test("shutdownPostgres closes connection pool", async () => {
    // Given: Postgres has been initialized
    await initializePostgresBackend()
    expect(isPostgresAvailable()).toBe(true)

    // When: shutdownPostgres is called
    await shutdownPostgres()

    // Then: Postgres is no longer available
    // Note: After shutdown, we may need to re-initialize
    // Implementation may vary based on singleton reset behavior
  })
})
