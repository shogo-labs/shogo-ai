/**
 * Default Value Handling Tests
 *
 * Tests that JSON Schema `default` values are properly:
 * 1. Captured during ingestion (ingestEnhancedJsonSchema)
 * 2. Stored on Property entities
 * 3. Output during reconstruction (toEnhancedJson)
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { createMetaStore } from "../meta-store"

describe("Default Value Handling", () => {
  let metaStore: any

  beforeEach(() => {
    const { createStore } = createMetaStore()
    metaStore = createStore()
  })

  describe("Ingestion", () => {
    test("ingestEnhancedJsonSchema captures string default values", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" }
            },
            required: ["id"]
          }
        }
      }

      const result = metaStore.ingestEnhancedJsonSchema(schema, { name: "test-defaults" })
      const taskModel = result.models.find((m: any) => m.name === "Task")
      const statusProp = taskModel.properties.find((p: any) => p.name === "status")

      expect(statusProp.default).toBe("pending")
    })

    test("ingestEnhancedJsonSchema captures numeric default values", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              priority: { type: "integer", default: 0 },
              weight: { type: "number", default: 1.5 }
            },
            required: ["id"]
          }
        }
      }

      const result = metaStore.ingestEnhancedJsonSchema(schema, { name: "test-numeric" })
      const taskModel = result.models.find((m: any) => m.name === "Task")
      const priorityProp = taskModel.properties.find((p: any) => p.name === "priority")
      const weightProp = taskModel.properties.find((p: any) => p.name === "weight")

      expect(priorityProp.default).toBe(0)
      expect(weightProp.default).toBe(1.5)
    })

    test("ingestEnhancedJsonSchema captures boolean default values", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              isActive: { type: "boolean", default: true },
              isArchived: { type: "boolean", default: false }
            },
            required: ["id"]
          }
        }
      }

      const result = metaStore.ingestEnhancedJsonSchema(schema, { name: "test-boolean" })
      const taskModel = result.models.find((m: any) => m.name === "Task")
      const isActiveProp = taskModel.properties.find((p: any) => p.name === "isActive")
      const isArchivedProp = taskModel.properties.find((p: any) => p.name === "isArchived")

      expect(isActiveProp.default).toBe(true)
      expect(isArchivedProp.default).toBe(false)
    })

    test("ingestEnhancedJsonSchema captures null default value", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              deletedAt: { type: "string", format: "date-time", default: null }
            },
            required: ["id"]
          }
        }
      }

      const result = metaStore.ingestEnhancedJsonSchema(schema, { name: "test-null" })
      const taskModel = result.models.find((m: any) => m.name === "Task")
      const deletedAtProp = taskModel.properties.find((p: any) => p.name === "deletedAt")

      expect(deletedAtProp.default).toBe(null)
    })
  })

  describe("Reconstruction", () => {
    test("toEnhancedJson outputs string default values", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" }
            },
            required: ["id"]
          }
        }
      }

      const result = metaStore.ingestEnhancedJsonSchema(schema, { name: "test-output" })
      const enhanced = result.toEnhancedJson

      expect(enhanced.$defs.Task.properties.status.default).toBe("pending")
    })

    test("toEnhancedJson outputs numeric default values", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              priority: { type: "integer", default: 0 }
            },
            required: ["id"]
          }
        }
      }

      const result = metaStore.ingestEnhancedJsonSchema(schema, { name: "test-output-num" })
      const enhanced = result.toEnhancedJson

      expect(enhanced.$defs.Task.properties.priority.default).toBe(0)
    })

    test("toEnhancedJson preserves null default value", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              deletedAt: { type: "string", default: null }
            },
            required: ["id"]
          }
        }
      }

      const result = metaStore.ingestEnhancedJsonSchema(schema, { name: "test-output-null" })
      const enhanced = result.toEnhancedJson

      expect(enhanced.$defs.Task.properties.deletedAt.default).toBe(null)
    })

    test("round-trip preserves all default value types", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" },
              priority: { type: "integer", default: 5 },
              isActive: { type: "boolean", default: true },
              metadata: { type: "string", default: null }
            },
            required: ["id"]
          }
        }
      }

      const result = metaStore.ingestEnhancedJsonSchema(schema, { name: "test-roundtrip" })
      const enhanced = result.toEnhancedJson

      expect(enhanced.$defs.Task.properties.status.default).toBe("pending")
      expect(enhanced.$defs.Task.properties.priority.default).toBe(5)
      expect(enhanced.$defs.Task.properties.isActive.default).toBe(true)
      expect(enhanced.$defs.Task.properties.metadata.default).toBe(null)
    })
  })
})
