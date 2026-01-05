/**
 * Seed Initialization Tests
 *
 * Tests for automatic seed data initialization at MCP server startup.
 * Validates studio-core schema loading, bootstrap execution, and idempotency.
 *
 * Generated from TestSpecifications:
 * - test-1-3-001: initializeSeedData creates Shogo org and Platform project when database is empty
 * - test-1-3-002: initializeSeedData is idempotent - skips creation when data exists
 * - test-1-3-003: initializeSeedData handles database errors gracefully
 * - test-1-3-004: initializeSeedData uses deterministic IDs from seeds/ids.ts
 * - test-1-3-005: initializeSeedData follows loadSchema pattern
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn, type Mock } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Import the function under test - will fail until implemented
import { initializeSeedData } from "../seed-init"

// Import for mocking
import * as postgresInit from "../postgres-init"
import * as stateApi from "@shogo/state-api"

// Seed IDs for verification - exported from @shogo/state-api
import { SHOGO_ORG_ID, PLATFORM_PROJECT_ID } from "@shogo/state-api"

// Track mocks for cleanup
let postgresAvailableSpy: Mock<typeof postgresInit.isPostgresAvailable> | null = null
let sqliteAvailableSpy: Mock<typeof postgresInit.isSqliteAvailable> | null = null
let registrySpy: Mock<typeof postgresInit.getGlobalBackendRegistry> | null = null
let loadSchemaSpy: Mock<typeof stateApi.loadSchema> | null = null
let domainSpy: Mock<typeof stateApi.domain> | null = null
let bootstrapSpy: Mock<typeof stateApi.bootstrapStudioCore> | null = null

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a mock studio-core schema
 */
function createStudioCoreSchema() {
  return {
    id: "studio-core",
    name: "studio-core",
    format: "enhanced-json-schema",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    "x-persistence": { backend: "postgres" },
    $defs: {
      Organization: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          name: { type: "string" },
          slug: { type: "string" },
          description: { type: "string" },
        },
        required: ["id", "name", "slug"],
      },
      Project: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          name: { type: "string" },
          organization: { type: "string", "x-mst-type": "reference" },
          tier: { type: "string" },
          status: { type: "string" },
        },
        required: ["id", "name"],
      },
      Member: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          userId: { type: "string" },
          role: { type: "string" },
          organization: { type: "string", "x-mst-type": "reference" },
        },
        required: ["id", "userId", "role"],
      },
    },
  }
}

/**
 * Create a temporary schemas directory with studio-core
 */
function createTempSchemasDir(): string {
  const tempDir = join(tmpdir(), `seed-init-test-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })

  // Add studio-core schema
  const studioCoreDir = join(tempDir, "studio-core")
  mkdirSync(studioCoreDir, { recursive: true })
  writeFileSync(
    join(studioCoreDir, "schema.json"),
    JSON.stringify(createStudioCoreSchema(), null, 2)
  )

  return tempDir
}

/**
 * Clean up temp directory
 */
function cleanupTempDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create mock store with organization and project collections
 */
function createMockStore(hasExistingData: boolean = false) {
  const organizations: any[] = hasExistingData
    ? [{ id: SHOGO_ORG_ID, name: "Shogo", slug: "shogo" }]
    : []
  const projects: any[] = hasExistingData
    ? [{ id: PLATFORM_PROJECT_ID, name: "shogo-platform" }]
    : []
  const members: any[] = []

  return {
    organizationCollection: {
      get: (id: string) => organizations.find((o) => o.id === id),
      all: () => organizations,
      add: mock((data: any) => {
        organizations.push(data)
        return data
      }),
    },
    projectCollection: {
      get: (id: string) => projects.find((p) => p.id === id),
      all: () => projects,
      add: mock((data: any) => {
        projects.push(data)
        return data
      }),
    },
    memberCollection: {
      get: (id: string) => members.find((m) => m.id === id),
      all: () => members,
      add: mock((data: any) => {
        members.push(data)
        return data
      }),
    },
    createMember: mock((data: any) => {
      members.push(data)
      return data
    }),
    loadAllFromBackend: mock(() => Promise.resolve()),
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("Seed Initialization", () => {
  let tempDir: string
  let consoleLogSpy: ReturnType<typeof spyOn>
  let consoleWarnSpy: ReturnType<typeof spyOn>
  let mockStore: ReturnType<typeof createMockStore>
  let mockRegistry: { executeDDL: ReturnType<typeof mock> }

  beforeEach(() => {
    tempDir = createTempSchemasDir()

    // Capture console output
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {})
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {})

    // Create mock registry
    mockRegistry = {
      executeDDL: mock(() =>
        Promise.resolve({
          success: true,
          statements: ["CREATE TABLE test"],
          executed: 1,
        })
      ),
    }

    // Default mocks - SQL backend available
    postgresAvailableSpy = spyOn(postgresInit, "isPostgresAvailable").mockReturnValue(true)
    sqliteAvailableSpy = spyOn(postgresInit, "isSqliteAvailable").mockReturnValue(false)
    registrySpy = spyOn(postgresInit, "getGlobalBackendRegistry").mockReturnValue(
      mockRegistry as any
    )
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
    consoleLogSpy.mockRestore()
    consoleWarnSpy.mockRestore()

    // Restore all mocks
    postgresAvailableSpy?.mockRestore()
    sqliteAvailableSpy?.mockRestore()
    registrySpy?.mockRestore()
    loadSchemaSpy?.mockRestore()
    domainSpy?.mockRestore()
    bootstrapSpy?.mockRestore()

    postgresAvailableSpy = null
    sqliteAvailableSpy = null
    registrySpy = null
    loadSchemaSpy = null
    domainSpy = null
    bootstrapSpy = null
  })

  describe("initializeSeedData", () => {
    test("creates Shogo org and Platform project when database is empty", async () => {
      // Given: studio-core schema exists on disk and database is empty
      mockStore = createMockStore(false) // Empty database

      // Mock domain factory
      const mockDomainFactory = {
        createStore: mock(() => mockStore),
      }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      // Mock loadSchema
      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      // Mock bootstrapStudioCore
      bootstrapSpy = spyOn(stateApi, "bootstrapStudioCore").mockReturnValue({
        alreadyBootstrapped: false,
        organization: { id: SHOGO_ORG_ID, name: "Shogo", slug: "shogo" },
        project: { id: PLATFORM_PROJECT_ID, name: "shogo-platform" },
        member: { id: "member-1", userId: "bootstrap-user", role: "owner" },
      })

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: Shogo organization exists
      expect(bootstrapSpy).toHaveBeenCalled()
      expect(bootstrapSpy).toHaveBeenCalledWith(mockStore, expect.any(String))

      // And: Function logs 'Seed data created' message
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Seed data created"))
    })

    test("is idempotent - skips creation when data exists", async () => {
      // Given: Shogo organization and Platform project already exist
      mockStore = createMockStore(true) // Has existing data

      const mockDomainFactory = {
        createStore: mock(() => mockStore),
      }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      // Mock bootstrapStudioCore to return already bootstrapped
      bootstrapSpy = spyOn(stateApi, "bootstrapStudioCore").mockReturnValue({
        alreadyBootstrapped: true,
        organization: { id: SHOGO_ORG_ID, name: "Shogo", slug: "shogo" },
        project: { id: PLATFORM_PROJECT_ID, name: "shogo-platform" },
      })

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: No error is thrown and no duplicates created
      expect(bootstrapSpy).toHaveBeenCalled()

      // And: Function logs 'Seed data already exists' message
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Seed data already exists")
      )
    })

    test("handles database errors gracefully", async () => {
      // Given: Database connection or query will fail
      const mockDomainFactory = {
        createStore: mock(() => {
          throw new Error("Database connection failed")
        }),
      }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      // When: initializeSeedData is called
      // Then: Error is logged with descriptive message
      await initializeSeedData(tempDir)

      // And: Function does not throw (returns normally)
      // The test completes without exception

      // And: Warning logged
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[seed-init]")
      )
    })

    test("uses deterministic IDs from seeds/ids.ts", async () => {
      // Given: studio-core schema exists on disk and database is empty
      mockStore = createMockStore(false)

      const mockDomainFactory = {
        createStore: mock(() => mockStore),
      }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      bootstrapSpy = spyOn(stateApi, "bootstrapStudioCore").mockReturnValue({
        alreadyBootstrapped: false,
        organization: { id: SHOGO_ORG_ID, name: "Shogo", slug: "shogo" },
        project: { id: PLATFORM_PROJECT_ID, name: "shogo-platform" },
        member: { id: "member-1", userId: "bootstrap-user", role: "owner" },
      })

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: bootstrapStudioCore is called (which uses deterministic IDs internally)
      expect(bootstrapSpy).toHaveBeenCalled()

      // Verify the deterministic IDs are correct
      expect(SHOGO_ORG_ID).toBe("00000000-0000-4000-8000-000000000001")
      expect(PLATFORM_PROJECT_ID).toBe("00000000-0000-4000-8000-000000000002")
    })

    test("follows loadSchema pattern", async () => {
      // Given: studio-core schema exists on disk
      mockStore = createMockStore(false)

      const mockDomainFactory = {
        createStore: mock(() => mockStore),
      }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      bootstrapSpy = spyOn(stateApi, "bootstrapStudioCore").mockReturnValue({
        alreadyBootstrapped: false,
        organization: { id: SHOGO_ORG_ID, name: "Shogo" },
        project: { id: PLATFORM_PROJECT_ID, name: "shogo-platform" },
      })

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: studio-core schema is loaded using loadSchema()
      expect(loadSchemaSpy).toHaveBeenCalledWith("studio-core", tempDir)

      // And: Runtime store is created with domain().createStore()
      expect(domainSpy).toHaveBeenCalled()
      expect(mockDomainFactory.createStore).toHaveBeenCalled()

      // And: Existing data is loaded before bootstrap check
      expect(mockStore.loadAllFromBackend).toHaveBeenCalled()
    })

    test("skips when no SQL backend available", async () => {
      // Given: No SQL backend is available
      postgresAvailableSpy?.mockReturnValue(false)
      sqliteAvailableSpy?.mockReturnValue(false)

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: Log indicates skip
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("No SQL backend available")
      )
    })

    test("skips when studio-core schema does not exist", async () => {
      // Given: studio-core schema does not exist
      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockRejectedValue(
        new Error("Schema not found")
      )

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: Warning logged but no crash
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[seed-init]")
      )
    })
  })
})
