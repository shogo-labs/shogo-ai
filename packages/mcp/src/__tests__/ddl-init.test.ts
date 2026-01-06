/**
 * DDL Initialization Tests
 *
 * Tests for automatic DDL initialization at MCP server startup.
 * Validates schema scanning, filtering, and DDL execution.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn, type Mock } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Import from implementation module - will fail until implemented
import { initializeDomainSchemas } from "../ddl-init"

// Mock postgres-init module
import * as postgresInit from "../postgres-init"

// Track mocks for cleanup
let postgresAvailableSpy: Mock<typeof postgresInit.isPostgresAvailable> | null = null
let sqliteAvailableSpy: Mock<typeof postgresInit.isSqliteAvailable> | null = null
let registrySpy: Mock<typeof postgresInit.getGlobalBackendRegistry> | null = null

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a test schema JSON with optional postgres backend
 */
function createTestSchema(name: string, hasPostgresBackend: boolean) {
  const schema: Record<string, unknown> = {
    id: `test-${name}`,
    name,
    format: "enhanced-json-schema",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: {
      TestModel: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
    },
  }

  if (hasPostgresBackend) {
    schema["x-persistence"] = { backend: "postgres" }
  }

  return schema
}

/**
 * Create a temporary schemas directory with test schemas
 */
function createTempSchemasDir(): string {
  const tempDir = join(tmpdir(), `ddl-init-test-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
  return tempDir
}

/**
 * Add a schema to the temp directory
 */
function addSchemaToDir(dir: string, name: string, schema: Record<string, unknown>) {
  const schemaDir = join(dir, name)
  mkdirSync(schemaDir, { recursive: true })
  writeFileSync(join(schemaDir, "schema.json"), JSON.stringify(schema, null, 2))
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

// ============================================================================
// Tests
// ============================================================================

describe("DDL Initialization", () => {
  let tempDir: string
  let consoleLogSpy: ReturnType<typeof spyOn>
  let consoleWarnSpy: ReturnType<typeof spyOn>
  let consoleErrorSpy: ReturnType<typeof spyOn>
  let mockRegistry: { syncSchema: ReturnType<typeof mock> }

  beforeEach(() => {
    tempDir = createTempSchemasDir()

    // Capture console output
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {})
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {})
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {})

    // Create mock registry with syncSchema (replaces old executeDDL)
    mockRegistry = {
      syncSchema: mock(() =>
        Promise.resolve({
          action: "created",
          version: 1,
          statements: ["CREATE TABLE test"],
        })
      ),
    }
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
    consoleLogSpy.mockRestore()
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    // Restore postgres-init mocks
    postgresAvailableSpy?.mockRestore()
    sqliteAvailableSpy?.mockRestore()
    registrySpy?.mockRestore()
    postgresAvailableSpy = null
    sqliteAvailableSpy = null
    registrySpy = null
  })

  describe("initializeDomainSchemas", () => {
    test("skips when no SQL backend available", async () => {
      // Given: No SQL backend is available
      postgresAvailableSpy = spyOn(postgresInit, "isPostgresAvailable").mockReturnValue(false)
      sqliteAvailableSpy = spyOn(postgresInit, "isSqliteAvailable").mockReturnValue(false)

      // Add a schema with postgres backend
      addSchemaToDir(tempDir, "test-schema", createTestSchema("test-schema", true))

      // When: initializeDomainSchemas is called
      await initializeDomainSchemas(tempDir)

      // Then: No DDL execution attempted
      expect(mockRegistry.syncSchema).not.toHaveBeenCalled()

      // And: Log indicates skip
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("No SQL backend available")
      )
    })

    test("scans directory and filters for postgres backend", async () => {
      // Given: SQL backend is available
      postgresAvailableSpy = spyOn(postgresInit, "isPostgresAvailable").mockReturnValue(true)
      sqliteAvailableSpy = spyOn(postgresInit, "isSqliteAvailable").mockReturnValue(false)
      registrySpy = spyOn(postgresInit, "getGlobalBackendRegistry").mockReturnValue(mockRegistry as any)

      // Add schemas - some with postgres backend, some without
      addSchemaToDir(tempDir, "schema-with-postgres", createTestSchema("schema-with-postgres", true))
      addSchemaToDir(tempDir, "schema-without-backend", createTestSchema("schema-without-backend", false))
      addSchemaToDir(tempDir, "another-postgres-schema", createTestSchema("another-postgres-schema", true))

      // When: initializeDomainSchemas is called
      await initializeDomainSchemas(tempDir)

      // Then: Only postgres-backend schemas trigger DDL
      expect(mockRegistry.syncSchema).toHaveBeenCalledTimes(2)
    })

    test("calls syncSchema for each postgres schema", async () => {
      // Given: SQL backend is available
      postgresAvailableSpy = spyOn(postgresInit, "isPostgresAvailable").mockReturnValue(true)
      sqliteAvailableSpy = spyOn(postgresInit, "isSqliteAvailable").mockReturnValue(false)
      registrySpy = spyOn(postgresInit, "getGlobalBackendRegistry").mockReturnValue(mockRegistry as any)

      // Add a schema with postgres backend
      const schema = createTestSchema("test-schema", true)
      addSchemaToDir(tempDir, "test-schema", schema)

      // When: initializeDomainSchemas is called
      await initializeDomainSchemas(tempDir)

      // Then: syncSchema called with schema name and content
      expect(mockRegistry.syncSchema).toHaveBeenCalledWith(
        "test-schema",
        expect.objectContaining({ name: "test-schema" })
      )
    })

    test("logs success for each schema", async () => {
      // Given: SQL backend is available and DDL succeeds
      postgresAvailableSpy = spyOn(postgresInit, "isPostgresAvailable").mockReturnValue(true)
      sqliteAvailableSpy = spyOn(postgresInit, "isSqliteAvailable").mockReturnValue(false)
      registrySpy = spyOn(postgresInit, "getGlobalBackendRegistry").mockReturnValue(mockRegistry as any)

      addSchemaToDir(tempDir, "test-schema", createTestSchema("test-schema", true))

      // When: initializeDomainSchemas is called
      await initializeDomainSchemas(tempDir)

      // Then: Success logged
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("[ddl-init]")
      )
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("test-schema")
      )
    })

    test("warns on DDL failure but continues processing", async () => {
      // Given: SQL backend is available but DDL fails for one schema
      postgresAvailableSpy = spyOn(postgresInit, "isPostgresAvailable").mockReturnValue(true)
      sqliteAvailableSpy = spyOn(postgresInit, "isSqliteAvailable").mockReturnValue(false)

      const failingMockRegistry = {
        syncSchema: mock((name: string) => {
          if (name === "failing-schema") {
            return Promise.reject(new Error("Test error"))
          }
          return Promise.resolve({
            action: "created",
            version: 1,
            statements: ["CREATE TABLE test"],
          })
        }),
      }
      registrySpy = spyOn(postgresInit, "getGlobalBackendRegistry").mockReturnValue(failingMockRegistry as any)

      // Add schemas
      addSchemaToDir(tempDir, "failing-schema", createTestSchema("failing-schema", true))
      addSchemaToDir(tempDir, "success-schema", createTestSchema("success-schema", true))

      // When: initializeDomainSchemas is called
      await initializeDomainSchemas(tempDir)

      // Then: Both schemas were processed
      expect(failingMockRegistry.syncSchema).toHaveBeenCalledTimes(2)

      // And: Error logged for failure
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failing-schema")
      )
    })

    test("warns on directory read failure", async () => {
      // Given: SQL backend is available
      postgresAvailableSpy = spyOn(postgresInit, "isPostgresAvailable").mockReturnValue(true)
      sqliteAvailableSpy = spyOn(postgresInit, "isSqliteAvailable").mockReturnValue(false)

      // When: initializeDomainSchemas is called with non-existent directory
      await initializeDomainSchemas("/non/existent/path")

      // Then: Warning logged, no throw
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[ddl-init]")
      )
    })

    test("handles malformed schema.json gracefully", async () => {
      // Given: SQL backend is available
      postgresAvailableSpy = spyOn(postgresInit, "isPostgresAvailable").mockReturnValue(true)
      sqliteAvailableSpy = spyOn(postgresInit, "isSqliteAvailable").mockReturnValue(false)
      registrySpy = spyOn(postgresInit, "getGlobalBackendRegistry").mockReturnValue(mockRegistry as any)

      // Add a valid schema
      addSchemaToDir(tempDir, "valid-schema", createTestSchema("valid-schema", true))

      // Add a malformed schema
      const malformedDir = join(tempDir, "malformed-schema")
      mkdirSync(malformedDir, { recursive: true })
      writeFileSync(join(malformedDir, "schema.json"), "{ invalid json }")

      // When: initializeDomainSchemas is called
      await initializeDomainSchemas(tempDir)

      // Then: Valid schema is still processed
      expect(mockRegistry.syncSchema).toHaveBeenCalledTimes(1)

      // And: No crash occurred
    })
  })
})
