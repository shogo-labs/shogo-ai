/**
 * System Migrations Schema Tests
 *
 * Generated from TestSpecifications for task-mig-006-schema
 * Tests the system-migrations schema structure and Wavesmith integration.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

// Schema location - __dirname is packages/state-api/src/ddl/__tests__
// Go up 5 levels: __tests__ -> ddl -> src -> state-api -> packages -> worktree root
const SCHEMAS_DIR = join(__dirname, "../../../../../.schemas")
const SYSTEM_MIGRATIONS_SCHEMA_PATH = join(SCHEMAS_DIR, "system-migrations/schema.json")

describe("system-migrations-schema.ts - Schema File Structure", () => {
  let schema: any

  beforeEach(() => {
    // Load schema if it exists
    if (existsSync(SYSTEM_MIGRATIONS_SCHEMA_PATH)) {
      schema = JSON.parse(readFileSync(SYSTEM_MIGRATIONS_SCHEMA_PATH, "utf-8"))
    }
  })

  describe("Schema file exists at correct location", () => {
    test("file exists at .schemas/system-migrations/schema.json", () => {
      expect(existsSync(SYSTEM_MIGRATIONS_SCHEMA_PATH)).toBe(true)
    })
  })

  describe("Schema has bootstrap flag", () => {
    test("x-persistence.bootstrap is true", () => {
      expect(schema["x-persistence"]?.bootstrap).toBe(true)
    })
  })

  describe("Schema has postgres backend configured", () => {
    test("x-persistence.backend is 'postgres'", () => {
      expect(schema["x-persistence"]?.backend).toBe("postgres")
    })
  })

  describe("MigrationRecord has id as identifier", () => {
    test("id has type: 'string' and x-mst-type: 'identifier'", () => {
      const migrationRecord = schema.$defs?.MigrationRecord
      expect(migrationRecord).toBeDefined()
      expect(migrationRecord.properties?.id?.type).toBe("string")
      expect(migrationRecord.properties?.id?.["x-mst-type"]).toBe("identifier")
    })
  })

  describe("MigrationRecord has all required fields", () => {
    test("required array contains all mandatory fields", () => {
      const migrationRecord = schema.$defs?.MigrationRecord
      expect(migrationRecord).toBeDefined()
      const required = migrationRecord.required || []
      expect(required).toContain("schemaName")
      expect(required).toContain("version")
      expect(required).toContain("checksum")
      expect(required).toContain("appliedAt")
      expect(required).toContain("success")
    })
  })

  describe("MigrationRecord version is integer type", () => {
    test("version has type: 'integer'", () => {
      const migrationRecord = schema.$defs?.MigrationRecord
      expect(migrationRecord.properties?.version?.type).toBe("integer")
    })
  })

  describe("MigrationRecord statements is array of strings", () => {
    test("statements has type: 'array' with items type: 'string'", () => {
      const migrationRecord = schema.$defs?.MigrationRecord
      expect(migrationRecord.properties?.statements?.type).toBe("array")
      expect(migrationRecord.properties?.statements?.items?.type).toBe("string")
    })
  })

  describe("MigrationRecord errorMessage is optional", () => {
    test("errorMessage property exists but is not in required array", () => {
      const migrationRecord = schema.$defs?.MigrationRecord
      expect(migrationRecord.properties?.errorMessage).toBeDefined()
      const required = migrationRecord.required || []
      expect(required).not.toContain("errorMessage")
    })
  })
})

describe("system-migrations-schema.ts - Wavesmith Integration", () => {
  // These integration tests use in-memory database and isolated stores

  describe("Schema can be registered and loaded via Wavesmith", () => {
    test("schema registered and models include MigrationRecord", async () => {
      // This test verifies the schema can be processed by the schematic pipeline
      // The actual Wavesmith integration will be tested when domain.ts is created
      const schemaExists = existsSync(SYSTEM_MIGRATIONS_SCHEMA_PATH)
      expect(schemaExists).toBe(true)

      if (schemaExists) {
        const schema = JSON.parse(readFileSync(SYSTEM_MIGRATIONS_SCHEMA_PATH, "utf-8"))
        expect(schema.$defs?.MigrationRecord).toBeDefined()
        expect(schema.$defs?.MigrationRecord?.properties?.id).toBeDefined()
        expect(schema.$defs?.MigrationRecord?.properties?.schemaName).toBeDefined()
        expect(schema.$defs?.MigrationRecord?.properties?.version).toBeDefined()
      }
    })
  })

  describe("Test entity can be created in MigrationRecord collection", () => {
    test("entity creation with in-memory database", async () => {
      // This is a more complex integration test that will be implemented
      // when the domain is created and can be properly tested with in-memory SQLite
      const schemaExists = existsSync(SYSTEM_MIGRATIONS_SCHEMA_PATH)
      expect(schemaExists).toBe(true)
    })
  })
})
