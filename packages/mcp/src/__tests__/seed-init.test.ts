/**
 * Seed Initialization Tests
 *
 * Tests for automatic seed data initialization at MCP server startup.
 * Validates studio-core schema loading, async query/insert pattern, and idempotency.
 *
 * Pattern under test:
 * - Uses .query().where().first() for idempotency check
 * - Uses .insertOne() for writes (syncs to backend)
 * - No FileSystemPersistence - routes through backendRegistry
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn, type Mock } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Import the function under test
import { initializeSeedData } from "../seed-init"

// Import for mocking
import * as postgresInit from "../postgres-init"
import * as stateApi from "@shogo/state-api"

// Seed IDs for verification
import { SHOGO_ORG_ID, PLATFORM_PROJECT_ID } from "@shogo/state-api"

// Track mocks for cleanup
let postgresAvailableSpy: Mock<typeof postgresInit.isPostgresAvailable> | null = null
let sqliteAvailableSpy: Mock<typeof postgresInit.isSqliteAvailable> | null = null
let registrySpy: Mock<typeof postgresInit.getGlobalBackendRegistry> | null = null
let loadSchemaSpy: Mock<typeof stateApi.loadSchema> | null = null
let domainSpy: Mock<typeof stateApi.domain> | null = null

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
          createdAt: { type: "number" },
        },
        required: ["id", "name", "slug"],
      },
      Project: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          name: { type: "string" },
          organization: { type: "string", "x-mst-type": "reference" },
          description: { type: "string" },
          createdAt: { type: "number" },
        },
        required: ["id", "name"],
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
 * Create chainable query mock that returns given result
 */
function createQueryChain(result: any = null) {
  const chain = {
    where: mock(() => chain),
    first: mock(() => Promise.resolve(result)),
  }
  return {
    query: mock(() => chain),
    _chain: chain,
  }
}

/**
 * Create mock store with queryable/mutatable collections
 */
function createMockStore(options: { hasExistingOrg?: boolean } = {}) {
  const { hasExistingOrg = false } = options

  // Organization collection with query + insertOne
  const orgQueryChain = createQueryChain(
    hasExistingOrg ? { id: SHOGO_ORG_ID, name: "Shogo", slug: "shogo" } : null
  )
  const orgInsertOne = mock((data: any) => Promise.resolve(data))

  // Project collection with query + insertOne
  const projectQueryChain = createQueryChain(null)
  const projectInsertOne = mock((data: any) => Promise.resolve(data))

  return {
    organizationCollection: {
      query: orgQueryChain.query,
      insertOne: orgInsertOne,
      _queryChain: orgQueryChain._chain,
    },
    projectCollection: {
      query: projectQueryChain.query,
      insertOne: projectInsertOne,
      _queryChain: projectQueryChain._chain,
    },
    _mocks: {
      orgQuery: orgQueryChain.query,
      orgWhere: orgQueryChain._chain.where,
      orgFirst: orgQueryChain._chain.first,
      orgInsertOne,
      projectQuery: projectQueryChain.query,
      projectInsertOne,
    },
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
  let mockRegistry: any

  beforeEach(() => {
    tempDir = createTempSchemasDir()

    // Capture console output
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {})
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {})

    // Create mock registry
    mockRegistry = {
      resolve: mock(() => ({ execute: mock(() => Promise.resolve({ items: [] })) })),
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

    postgresAvailableSpy = null
    sqliteAvailableSpy = null
    registrySpy = null
    loadSchemaSpy = null
    domainSpy = null
  })

  describe("initializeSeedData", () => {
    test("creates store with backendRegistry (no FileSystemPersistence)", async () => {
      // Given: Global backend registry exists and store is empty
      mockStore = createMockStore({ hasExistingOrg: false })

      const createStoreMock = mock(() => mockStore)
      const mockDomainFactory = { createStore: createStoreMock }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: createStore called with backendRegistry, NOT FileSystemPersistence
      expect(createStoreMock).toHaveBeenCalled()
      const createStoreArgs = createStoreMock.mock.calls[0][0]

      // Should have backendRegistry
      expect(createStoreArgs.services.backendRegistry).toBeDefined()

      // Should NOT have persistence (FileSystemPersistence)
      expect(createStoreArgs.services.persistence).toBeUndefined()
    })

    test("uses collection.query().where().first() for idempotency check", async () => {
      // Given: Store with queryable collections
      mockStore = createMockStore({ hasExistingOrg: false })

      const mockDomainFactory = { createStore: mock(() => mockStore) }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: organizationCollection.query().where().first() was called
      expect(mockStore._mocks.orgQuery).toHaveBeenCalled()
      expect(mockStore._mocks.orgWhere).toHaveBeenCalledWith({ id: SHOGO_ORG_ID })
      expect(mockStore._mocks.orgFirst).toHaveBeenCalled()
    })

    test("creates seed data via collection.insertOne() when database is empty", async () => {
      // Given: Empty store (no existing seed data)
      mockStore = createMockStore({ hasExistingOrg: false })

      const mockDomainFactory = { createStore: mock(() => mockStore) }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: insertOne() called for org with correct data
      expect(mockStore._mocks.orgInsertOne).toHaveBeenCalled()
      const orgInsertCall = mockStore._mocks.orgInsertOne.mock.calls[0][0]
      expect(orgInsertCall.id).toBe(SHOGO_ORG_ID)
      expect(orgInsertCall.name).toBe("Shogo")
      expect(orgInsertCall.slug).toBe("shogo")

      // And: insertOne() called for project with correct data
      expect(mockStore._mocks.projectInsertOne).toHaveBeenCalled()
      const projectInsertCall = mockStore._mocks.projectInsertOne.mock.calls[0][0]
      expect(projectInsertCall.id).toBe(PLATFORM_PROJECT_ID)
      expect(projectInsertCall.name).toBe("shogo-platform")
      expect(projectInsertCall.organization).toBe(SHOGO_ORG_ID)
      expect(projectInsertCall.tier).toBe("internal")
      expect(projectInsertCall.status).toBe("active")

      // And: Function logs 'Seed data created' message
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Seed data created"))
    })

    test("skips creation when seed data already exists (idempotent)", async () => {
      // Given: Store with existing SHOGO_ORG_ID
      mockStore = createMockStore({ hasExistingOrg: true })

      const mockDomainFactory = { createStore: mock(() => mockStore) }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: query was called to check existence
      expect(mockStore._mocks.orgQuery).toHaveBeenCalled()
      expect(mockStore._mocks.orgFirst).toHaveBeenCalled()

      // And: insertOne() was NOT called (data already exists)
      expect(mockStore._mocks.orgInsertOne).not.toHaveBeenCalled()
      expect(mockStore._mocks.projectInsertOne).not.toHaveBeenCalled()

      // And: Function logs 'Seed data already exists' message
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Seed data already exists")
      )
    })

    test("logs warning and continues on query error", async () => {
      // Given: query() throws error
      mockStore = createMockStore({ hasExistingOrg: false })
      mockStore._mocks.orgFirst.mockRejectedValue(new Error("Database query failed"))

      const mockDomainFactory = { createStore: mock(() => mockStore) }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: Warning logged, no crash
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[seed-init]")
      )

      // And: Function completes without throwing
      // (test would fail if exception propagated)
    })

    test("uses deterministic IDs from seeds/ids.ts", async () => {
      // Given: Empty store
      mockStore = createMockStore({ hasExistingOrg: false })

      const mockDomainFactory = { createStore: mock(() => mockStore) }
      domainSpy = spyOn(stateApi, "domain").mockReturnValue(mockDomainFactory as any)

      loadSchemaSpy = spyOn(stateApi, "loadSchema").mockResolvedValue({
        metadata: { name: "studio-core" },
        enhanced: createStudioCoreSchema(),
      } as any)

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: Query uses deterministic SHOGO_ORG_ID
      expect(mockStore._mocks.orgWhere).toHaveBeenCalledWith({ id: SHOGO_ORG_ID })

      // And: Insert uses deterministic IDs
      const orgInsertCall = mockStore._mocks.orgInsertOne.mock.calls[0][0]
      expect(orgInsertCall.id).toBe(SHOGO_ORG_ID)

      const projectInsertCall = mockStore._mocks.projectInsertOne.mock.calls[0][0]
      expect(projectInsertCall.id).toBe(PLATFORM_PROJECT_ID)

      // And: Verify the deterministic IDs are correct constants
      expect(SHOGO_ORG_ID).toBe("00000000-0000-4000-8000-000000000001")
      expect(PLATFORM_PROJECT_ID).toBe("00000000-0000-4000-8000-000000000002")
    })

    test("skips when no SQL backend available", async () => {
      // Given: No SQL backend is available
      postgresAvailableSpy?.mockReturnValue(false)
      sqliteAvailableSpy?.mockReturnValue(false)

      // Set up domain spy to verify it's NOT called
      domainSpy = spyOn(stateApi, "domain").mockReturnValue({ createStore: mock(() => ({})) } as any)

      // When: initializeSeedData is called
      await initializeSeedData(tempDir)

      // Then: Log indicates skip
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("No SQL backend available")
      )

      // And: domain() was never called (early return)
      expect(domainSpy).not.toHaveBeenCalled()
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
