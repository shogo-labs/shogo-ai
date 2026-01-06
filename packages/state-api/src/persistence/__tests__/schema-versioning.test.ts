/**
 * Schema Versioning Tests
 *
 * Generated from TestSpecifications for task-mig-002-versioning
 * Tests schema version tracking and history snapshot functionality.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import {
  saveSchema,
  loadSchema,
  getSchemaVersion,
  getSchemaSnapshot,
  listSchemaVersions,
} from "../schema-io"

// Test workspace - use temp directory for isolation
const TEST_WORKSPACE = path.join(process.cwd(), ".test-schemas-versioning")

// Helper to create mock schema object
function createMockSchema(name: string, content: Record<string, any> = {}) {
  return {
    id: `schema-${name}`,
    name,
    format: "enhanced-json-schema",
    createdAt: Date.now(),
    toEnhancedJson: {
      $schema: "http://json-schema.org/draft-07/schema#",
      $defs: content,
    },
  }
}

describe("schema-versioning.ts", () => {
  // Setup: create test workspace
  beforeEach(async () => {
    await fs.mkdir(TEST_WORKSPACE, { recursive: true })
  })

  // Cleanup: remove test workspace
  afterEach(async () => {
    try {
      await fs.rm(TEST_WORKSPACE, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe("Schema version starts at 1 for new schemas", () => {
    test("saveSchema() sets version to 1 for first save", async () => {
      const schema = createMockSchema("test-schema", {
        User: { type: "object", properties: { id: { type: "string" } } },
      })

      await saveSchema(schema, undefined, TEST_WORKSPACE)

      // Read schema file directly to verify version
      const schemaFile = JSON.parse(
        await fs.readFile(`${TEST_WORKSPACE}/test-schema/schema.json`, "utf-8")
      )
      expect(schemaFile.version).toBe(1)
    })
  })

  describe("Schema version increments on save", () => {
    test("saveSchema() increments version and creates history snapshot", async () => {
      const schema = createMockSchema("test-schema", {
        User: { type: "object", properties: { id: { type: "string" } } },
      })

      // First save (version 1)
      await saveSchema(schema, undefined, TEST_WORKSPACE)

      // Modify schema
      const modifiedSchema = createMockSchema("test-schema", {
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            email: { type: "string" },
          },
        },
      })

      // Second save (should be version 2)
      await saveSchema(modifiedSchema, undefined, TEST_WORKSPACE)

      // Verify current version is 2
      const schemaFile = JSON.parse(
        await fs.readFile(`${TEST_WORKSPACE}/test-schema/schema.json`, "utf-8")
      )
      expect(schemaFile.version).toBe(2)

      // Verify v1 snapshot was saved
      const v1Exists = await fs
        .stat(`${TEST_WORKSPACE}/test-schema/history/v1.json`)
        .then(() => true)
        .catch(() => false)
      expect(v1Exists).toBe(true)

      // Verify v1 snapshot contains original content
      const v1Snapshot = JSON.parse(
        await fs.readFile(`${TEST_WORKSPACE}/test-schema/history/v1.json`, "utf-8")
      )
      expect(v1Snapshot.version).toBe(1)
      expect(v1Snapshot.$defs.User.properties.email).toBeUndefined()
    })
  })

  describe("History directory created automatically", () => {
    test("saveSchema() creates history directory on version increment", async () => {
      const schema = createMockSchema("test-schema")

      // First save
      await saveSchema(schema, undefined, TEST_WORKSPACE)

      // Verify history doesn't exist yet (no snapshots needed for v1)
      const historyExistsBeforeSecondSave = await fs
        .stat(`${TEST_WORKSPACE}/test-schema/history`)
        .then(() => true)
        .catch(() => false)
      // Note: history directory may or may not exist after first save
      // What matters is it exists after second save

      // Second save
      await saveSchema(schema, undefined, TEST_WORKSPACE)

      // Verify history directory now exists
      const historyExists = await fs
        .stat(`${TEST_WORKSPACE}/test-schema/history`)
        .then(() => true)
        .catch(() => false)
      expect(historyExists).toBe(true)
    })
  })

  describe("loadSchema returns version in metadata", () => {
    test("loadSchema() includes version in returned metadata", async () => {
      const schema = createMockSchema("test-schema")

      // Create schema at version 3 by saving 3 times
      await saveSchema(schema, undefined, TEST_WORKSPACE)
      await saveSchema(schema, undefined, TEST_WORKSPACE)
      await saveSchema(schema, undefined, TEST_WORKSPACE)

      const result = await loadSchema("test-schema", TEST_WORKSPACE)

      expect(result.metadata.version).toBe(3)
    })
  })

  describe("getSchemaVersion returns current version", () => {
    test("getSchemaVersion() returns correct version number", async () => {
      const schema = createMockSchema("test-schema")

      // Create schema at version 5
      for (let i = 0; i < 5; i++) {
        await saveSchema(schema, undefined, TEST_WORKSPACE)
      }

      const version = await getSchemaVersion("test-schema", TEST_WORKSPACE)

      expect(version).toBe(5)
    })

    test("getSchemaVersion() returns 0 for non-existent schema", async () => {
      const version = await getSchemaVersion("non-existent", TEST_WORKSPACE)
      expect(version).toBe(0)
    })
  })

  describe("getSchemaSnapshot loads specific historical version", () => {
    test("getSchemaSnapshot() loads correct historical version", async () => {
      // Create schema with v1 content
      const schemaV1 = createMockSchema("test-schema", {
        User: { type: "object", properties: { id: { type: "string" } } },
      })
      await saveSchema(schemaV1, undefined, TEST_WORKSPACE)

      // Create v2 with modified content
      const schemaV2 = createMockSchema("test-schema", {
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      })
      await saveSchema(schemaV2, undefined, TEST_WORKSPACE)

      // Create v3 with more modifications
      const schemaV3 = createMockSchema("test-schema", {
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            email: { type: "string" },
          },
        },
      })
      await saveSchema(schemaV3, undefined, TEST_WORKSPACE)

      // Load v2 snapshot
      const snapshot = await getSchemaSnapshot("test-schema", 2, TEST_WORKSPACE)

      expect(snapshot.version).toBe(2)
      expect(snapshot.schema.$defs.User.properties.name).toBeDefined()
      expect(snapshot.schema.$defs.User.properties.email).toBeUndefined()
    })
  })

  describe("listSchemaVersions returns all available versions", () => {
    test("listSchemaVersions() returns sorted version array", async () => {
      const schema = createMockSchema("test-schema")

      // Create 4 versions
      for (let i = 0; i < 4; i++) {
        await saveSchema(schema, undefined, TEST_WORKSPACE)
      }

      const versions = await listSchemaVersions("test-schema", TEST_WORKSPACE)

      // Should include v1, v2, v3 in history, plus current v4
      expect(versions).toEqual([1, 2, 3, 4])
    })

    test("listSchemaVersions() returns empty array for non-existent schema", async () => {
      const versions = await listSchemaVersions("non-existent", TEST_WORKSPACE)
      expect(versions).toEqual([])
    })
  })

  describe("Error thrown for non-existent snapshot version", () => {
    test("getSchemaSnapshot() throws for missing version", async () => {
      const schema = createMockSchema("test-schema")

      // Create only 2 versions
      await saveSchema(schema, undefined, TEST_WORKSPACE)
      await saveSchema(schema, undefined, TEST_WORKSPACE)

      // Try to get version 99
      await expect(
        getSchemaSnapshot("test-schema", 99, TEST_WORKSPACE)
      ).rejects.toThrow(/version.*not found/i)
    })
  })
})
