/**
 * MST Default Value Tests
 *
 * Tests that JSON Schema `default` values are properly applied
 * to MST models via types.optional(type, defaultValue)
 */

import { describe, test, expect } from "bun:test"
import { enhancedJsonSchemaToMST } from "../enhanced-json-schema-to-mst"

describe("MST Default Values", () => {
  describe("String defaults", () => {
    test("optional string property uses JSON Schema default", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            "x-original-name": "Task",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" }
            },
            required: ["id"]
          }
        }
      }

      const { createStore } = enhancedJsonSchemaToMST(schema)
      const store = createStore()
      const task = store.taskCollection.add({ id: "1" })

      expect(task.status).toBe("pending")
    })

    test("provided value overrides default", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            "x-original-name": "Task",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" }
            },
            required: ["id"]
          }
        }
      }

      const { createStore } = enhancedJsonSchemaToMST(schema)
      const store = createStore()
      const task = store.taskCollection.add({ id: "1", status: "completed" })

      expect(task.status).toBe("completed")
    })
  })

  describe("Numeric defaults", () => {
    test("optional integer property uses JSON Schema default", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            "x-original-name": "Task",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              priority: { type: "integer", default: 0 }
            },
            required: ["id"]
          }
        }
      }

      const { createStore } = enhancedJsonSchemaToMST(schema)
      const store = createStore()
      const task = store.taskCollection.add({ id: "1" })

      expect(task.priority).toBe(0)
    })

    test("optional number property uses JSON Schema default", () => {
      const schema = {
        $defs: {
          Item: {
            type: "object",
            "x-original-name": "Item",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              weight: { type: "number", default: 1.5 }
            },
            required: ["id"]
          }
        }
      }

      const { createStore } = enhancedJsonSchemaToMST(schema)
      const store = createStore()
      const item = store.itemCollection.add({ id: "1" })

      expect(item.weight).toBe(1.5)
    })

    test("zero is a valid default (not treated as falsy)", () => {
      const schema = {
        $defs: {
          Counter: {
            type: "object",
            "x-original-name": "Counter",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              count: { type: "integer", default: 0 }
            },
            required: ["id"]
          }
        }
      }

      const { createStore } = enhancedJsonSchemaToMST(schema)
      const store = createStore()
      const counter = store.counterCollection.add({ id: "1" })

      expect(counter.count).toBe(0)
    })
  })

  describe("Boolean defaults", () => {
    test("optional boolean property uses JSON Schema default true", () => {
      const schema = {
        $defs: {
          Feature: {
            type: "object",
            "x-original-name": "Feature",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              isEnabled: { type: "boolean", default: true }
            },
            required: ["id"]
          }
        }
      }

      const { createStore } = enhancedJsonSchemaToMST(schema)
      const store = createStore()
      const feature = store.featureCollection.add({ id: "1" })

      expect(feature.isEnabled).toBe(true)
    })

    test("optional boolean property uses JSON Schema default false", () => {
      const schema = {
        $defs: {
          Feature: {
            type: "object",
            "x-original-name": "Feature",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              isArchived: { type: "boolean", default: false }
            },
            required: ["id"]
          }
        }
      }

      const { createStore } = enhancedJsonSchemaToMST(schema)
      const store = createStore()
      const feature = store.featureCollection.add({ id: "1" })

      expect(feature.isArchived).toBe(false)
    })
  })

  describe("Without defaults", () => {
    test("optional property without default is undefined", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            "x-original-name": "Task",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              description: { type: "string" }  // No default
            },
            required: ["id"]
          }
        }
      }

      const { createStore } = enhancedJsonSchemaToMST(schema)
      const store = createStore()
      const task = store.taskCollection.add({ id: "1" })

      expect(task.description).toBeUndefined()
    })
  })

  describe("Multiple properties with defaults", () => {
    test("all defaults are applied correctly", () => {
      const schema = {
        $defs: {
          Task: {
            type: "object",
            "x-original-name": "Task",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              status: { type: "string", default: "pending" },
              priority: { type: "integer", default: 5 },
              isActive: { type: "boolean", default: true },
              description: { type: "string" }  // No default
            },
            required: ["id"]
          }
        }
      }

      const { createStore } = enhancedJsonSchemaToMST(schema)
      const store = createStore()
      const task = store.taskCollection.add({ id: "1" })

      expect(task.status).toBe("pending")
      expect(task.priority).toBe(5)
      expect(task.isActive).toBe(true)
      expect(task.description).toBeUndefined()
    })
  })
})
