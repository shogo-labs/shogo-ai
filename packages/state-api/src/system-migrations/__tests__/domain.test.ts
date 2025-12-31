/**
 * System Migrations Domain Tests
 *
 * Generated from TestSpecifications for task-mig-006-schema
 * Tests the SystemMigrationsDomain ArkType scope and domain() result.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { existsSync } from "fs"
import { join } from "path"
import { SystemMigrationsDomain, systemMigrationsDomain } from "../domain"

// Domain location
const DOMAIN_PATH = join(__dirname, "../domain.ts")

describe("system-migrations/domain.ts - Domain File Structure", () => {
  describe("Domain file exists at correct location", () => {
    test("file exists at packages/state-api/src/system-migrations/domain.ts", () => {
      expect(existsSync(DOMAIN_PATH)).toBe(true)
    })
  })

  describe("Domain exports SystemMigrationsDomain scope", () => {
    test("SystemMigrationsDomain is a valid ArkType scope", () => {
      expect(SystemMigrationsDomain).toBeDefined()
      // ArkType scope provides .export() method for type access
      expect(typeof SystemMigrationsDomain.export).toBe("function")
    })
  })

  describe("Domain exports systemMigrationsDomain result", () => {
    test("systemMigrationsDomain is result of domain() call with correct name", () => {
      expect(systemMigrationsDomain).toBeDefined()
      expect(systemMigrationsDomain.name).toBe("system-migrations")
    })

    test("systemMigrationsDomain.createStore is a function", () => {
      expect(typeof systemMigrationsDomain.createStore).toBe("function")
    })

    test("systemMigrationsDomain.enhancedSchema is defined", () => {
      expect(systemMigrationsDomain.enhancedSchema).toBeDefined()
    })
  })
})

describe("MigrationRecord entity has correct field types", () => {
  let store: any

  beforeEach(() => {
    store = systemMigrationsDomain.createStore()
  })

  test("MigrationRecord entity accepts valid data", () => {
    const record = store.migrationRecordCollection.add({
      id: crypto.randomUUID(),
      schemaName: "test-schema",
      version: 1,
      checksum: "abc123",
      appliedAt: Date.now(),
      statements: ["CREATE TABLE test (id TEXT)"],
      success: true,
    })

    expect(record.id).toBeDefined()
    expect(typeof record.schemaName).toBe("string")
    expect(typeof record.version).toBe("number")
    expect(typeof record.checksum).toBe("string")
    expect(typeof record.appliedAt).toBe("number")
    expect(Array.isArray(record.statements)).toBe(true)
    expect(typeof record.success).toBe("boolean")
  })

  test("MigrationRecord accepts optional errorMessage", () => {
    const record = store.migrationRecordCollection.add({
      id: crypto.randomUUID(),
      schemaName: "test-schema",
      version: 1,
      checksum: "abc123",
      appliedAt: Date.now(),
      statements: ["CREATE TABLE test (id TEXT)"],
      success: false,
      errorMessage: "Failed to execute",
    })

    expect(record.errorMessage).toBe("Failed to execute")
  })
})

describe("MigrationRecordCollection query methods", () => {
  let store: any

  beforeEach(() => {
    store = systemMigrationsDomain.createStore()
    // Add test data
    store.migrationRecordCollection.add({
      id: crypto.randomUUID(),
      schemaName: "schema-a",
      version: 1,
      checksum: "aaa111",
      appliedAt: 1000,
      statements: [],
      success: true,
    })
    store.migrationRecordCollection.add({
      id: crypto.randomUUID(),
      schemaName: "schema-a",
      version: 2,
      checksum: "aaa222",
      appliedAt: 2000,
      statements: [],
      success: true,
    })
    store.migrationRecordCollection.add({
      id: crypto.randomUUID(),
      schemaName: "schema-b",
      version: 1,
      checksum: "bbb111",
      appliedAt: 1500,
      statements: [],
      success: false,
      errorMessage: "test error",
    })
  })

  test("forSchema returns migrations for specific schema ordered by version", () => {
    const migrations = store.migrationRecordCollection.forSchema("schema-a")
    expect(migrations.length).toBe(2)
    expect(migrations[0].version).toBe(1)
    expect(migrations[1].version).toBe(2)
  })

  test("latestForSchema returns most recent migration", () => {
    const latest = store.migrationRecordCollection.latestForSchema("schema-a")
    expect(latest).toBeDefined()
    expect(latest.version).toBe(2)
  })

  test("hasVersion returns true for applied version", () => {
    expect(store.migrationRecordCollection.hasVersion("schema-a", 1)).toBe(true)
    expect(store.migrationRecordCollection.hasVersion("schema-a", 2)).toBe(true)
    expect(store.migrationRecordCollection.hasVersion("schema-a", 3)).toBe(false)
  })

  test("successful returns only successful migrations", () => {
    const successful = store.migrationRecordCollection.successful()
    expect(successful.length).toBe(2)
    expect(successful.every((r: any) => r.success)).toBe(true)
  })

  test("failed returns only failed migrations", () => {
    const failed = store.migrationRecordCollection.failed()
    expect(failed.length).toBe(1)
    expect(failed.every((r: any) => !r.success)).toBe(true)
  })
})

describe("RootStore domain actions", () => {
  let store: any

  beforeEach(() => {
    store = systemMigrationsDomain.createStore()
  })

  test("recordSuccess creates successful migration record", () => {
    const record = store.recordSuccess(
      "test-schema",
      1,
      "checksum123",
      ["CREATE TABLE test (id TEXT)"]
    )

    expect(record.schemaName).toBe("test-schema")
    expect(record.version).toBe(1)
    expect(record.checksum).toBe("checksum123")
    expect(record.success).toBe(true)
    expect(record.statements).toEqual(["CREATE TABLE test (id TEXT)"])
    expect(record.appliedAt).toBeGreaterThan(0)

    // Verify it's in the collection
    expect(store.migrationRecordCollection.all().length).toBe(1)
  })

  test("recordFailure creates failed migration record with error message", () => {
    const record = store.recordFailure(
      "test-schema",
      1,
      "checksum456",
      ["CREATE TABLE test (id TEXT)"],
      "Something went wrong"
    )

    expect(record.schemaName).toBe("test-schema")
    expect(record.version).toBe(1)
    expect(record.success).toBe(false)
    expect(record.errorMessage).toBe("Something went wrong")

    // Verify it's in the collection
    expect(store.migrationRecordCollection.all().length).toBe(1)
  })
})
