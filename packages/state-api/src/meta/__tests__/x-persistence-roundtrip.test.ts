/**
 * x-persistence Round-Trip Tests
 *
 * Tests for preserving x-persistence extension through meta-store
 * ingest → toEnhancedJson round-trip.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { getMetaStore, resetMetaStore } from "../bootstrap"
import { saveSchema, loadSchema } from "../../persistence/schema-io"
import * as fs from "fs/promises"
import * as path from "path"

describe("x-persistence Round-Trip", () => {
  beforeEach(() => {
    resetMetaStore()
  })

  test("preserves entity-per-file strategy with displayKey", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Initiative: {
          type: "object",
          "x-persistence": {
            strategy: "entity-per-file",
            displayKey: "name"
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          },
          required: ["id", "name"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-persistence"
    })

    const output = schema.toEnhancedJson

    expect(output.$defs.Initiative["x-persistence"]).toBeDefined()
    expect(output.$defs.Initiative["x-persistence"].strategy).toBe("entity-per-file")
    expect(output.$defs.Initiative["x-persistence"].displayKey).toBe("name")
  })

  test("preserves array-per-partition strategy with partitionKey", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        IdeaNote: {
          type: "object",
          "x-persistence": {
            strategy: "array-per-partition",
            partitionKey: "initiativeId"
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            initiativeId: { type: "string" },
            content: { type: "string" }
          },
          required: ["id", "initiativeId", "content"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-partition"
    })

    const output = schema.toEnhancedJson

    expect(output.$defs.IdeaNote["x-persistence"]).toBeDefined()
    expect(output.$defs.IdeaNote["x-persistence"].strategy).toBe("array-per-partition")
    expect(output.$defs.IdeaNote["x-persistence"].partitionKey).toBe("initiativeId")
  })

  test("preserves flat strategy (explicit)", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Config: {
          type: "object",
          "x-persistence": {
            strategy: "flat"
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            value: { type: "string" }
          },
          required: ["id", "value"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-flat"
    })

    const output = schema.toEnhancedJson

    expect(output.$defs.Config["x-persistence"]).toBeDefined()
    expect(output.$defs.Config["x-persistence"].strategy).toBe("flat")
  })

  test("handles models without x-persistence (backward compat)", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          },
          required: ["id", "name"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-no-persistence"
    })

    const output = schema.toEnhancedJson

    // Should not add x-persistence if not present in input
    expect(output.$defs.User["x-persistence"]).toBeUndefined()
  })

  test("preserves x-persistence across multiple models in same schema", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Initiative: {
          type: "object",
          "x-persistence": {
            strategy: "entity-per-file",
            displayKey: "name"
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        },
        BacklogItem: {
          type: "object",
          "x-persistence": {
            strategy: "entity-per-file",
            displayKey: "title"
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            title: { type: "string" }
          }
        },
        IdeaNote: {
          type: "object",
          "x-persistence": {
            strategy: "array-per-partition",
            partitionKey: "initiativeId"
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            initiativeId: { type: "string" }
          }
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-multi-model"
    })

    const output = schema.toEnhancedJson

    expect(output.$defs.Initiative["x-persistence"].strategy).toBe("entity-per-file")
    expect(output.$defs.Initiative["x-persistence"].displayKey).toBe("name")

    expect(output.$defs.BacklogItem["x-persistence"].strategy).toBe("entity-per-file")
    expect(output.$defs.BacklogItem["x-persistence"].displayKey).toBe("title")

    expect(output.$defs.IdeaNote["x-persistence"].strategy).toBe("array-per-partition")
    expect(output.$defs.IdeaNote["x-persistence"].partitionKey).toBe("initiativeId")
  })
})

describe("x-persistence Disk Round-Trip", () => {
  const testDir = "/tmp/x-persistence-test"

  beforeEach(async () => {
    resetMetaStore()
    await fs.mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true })
  })

  test("preserves x-persistence through saveSchema → loadSchema", async () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Initiative: {
          type: "object",
          "x-persistence": {
            strategy: "entity-per-file",
            displayKey: "name"
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          },
          required: ["id", "name"]
        },
        IdeaNote: {
          type: "object",
          "x-persistence": {
            strategy: "array-per-partition",
            partitionKey: "initiativeId"
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            initiativeId: { type: "string" }
          },
          required: ["id", "initiativeId"]
        }
      }
    }

    // Ingest schema
    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-disk-persistence"
    })

    // Save to disk
    await saveSchema(schema, undefined, testDir)

    // Verify file on disk contains x-persistence
    const savedFile = await fs.readFile(
      path.join(testDir, "test-disk-persistence", "schema.json"),
      "utf-8"
    )
    const savedJson = JSON.parse(savedFile)

    expect(savedJson.$defs.Initiative["x-persistence"]).toBeDefined()
    expect(savedJson.$defs.Initiative["x-persistence"].strategy).toBe("entity-per-file")
    expect(savedJson.$defs.Initiative["x-persistence"].displayKey).toBe("name")

    expect(savedJson.$defs.IdeaNote["x-persistence"]).toBeDefined()
    expect(savedJson.$defs.IdeaNote["x-persistence"].strategy).toBe("array-per-partition")
    expect(savedJson.$defs.IdeaNote["x-persistence"].partitionKey).toBe("initiativeId")

    // Load from disk and verify
    const loaded = await loadSchema("test-disk-persistence", testDir)
    expect(loaded.enhanced.$defs.Initiative["x-persistence"].strategy).toBe("entity-per-file")
    expect(loaded.enhanced.$defs.IdeaNote["x-persistence"].partitionKey).toBe("initiativeId")
  })
})
