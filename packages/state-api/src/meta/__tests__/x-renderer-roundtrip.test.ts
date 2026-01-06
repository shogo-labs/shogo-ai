/**
 * x-renderer Round-Trip Tests
 * Task: task-meta-registry-extension
 *
 * Tests for preserving x-renderer extension through meta-store
 * ingest -> toEnhancedJson round-trip.
 *
 * Verifies that:
 * 1. Property entity in meta-registry includes xRenderer field
 * 2. PropertyEnhancements exposes xRenderer view
 * 3. xRenderer round-trips through toJsonSchema() / toEnhancedJson
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { getMetaStore, resetMetaStore } from "../bootstrap"

describe("x-renderer meta-registry extension", () => {
  beforeEach(() => {
    resetMetaStore()
  })

  test("Property entity in meta-registry includes xRenderer field", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Status: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            value: {
              type: "string",
              enum: ["active", "inactive"],
              "x-renderer": "status-badge"
            }
          },
          required: ["id", "value"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-x-renderer"
    })

    // Find the property with x-renderer
    const statusModel = metaStore.modelCollection.all().find(
      (m: any) => m.name === "Status"
    )
    expect(statusModel).toBeDefined()

    const valueProperty = metaStore.propertyCollection.all().find(
      (p: any) => p.model === statusModel && p.name === "value"
    )
    expect(valueProperty).toBeDefined()
    expect(valueProperty.xRenderer).toBe("status-badge")
  })

  test("PropertyEnhancements exposes xRenderer in toJsonSchema()", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Email: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            address: {
              type: "string",
              format: "email",
              "x-renderer": "mailto-link"
            }
          },
          required: ["id", "address"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-x-renderer-json"
    })

    // Find the property
    const emailModel = metaStore.modelCollection.all().find(
      (m: any) => m.name === "Email"
    )
    const addressProperty = metaStore.propertyCollection.all().find(
      (p: any) => p.model === emailModel && p.name === "address"
    )

    // toJsonSchema() should include x-renderer
    const jsonSchema = addressProperty.toJsonSchema()
    expect(jsonSchema["x-renderer"]).toBe("mailto-link")
    expect(jsonSchema.type).toBe("string")
    expect(jsonSchema.format).toBe("email")
  })

  test("xRenderer round-trips through ingest -> toEnhancedJson", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Task: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            priority: {
              type: "string",
              enum: ["low", "medium", "high"],
              "x-renderer": "priority-badge"
            },
            createdAt: {
              type: "string",
              format: "date-time",
              "x-renderer": "relative-time"
            }
          },
          required: ["id", "priority"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-roundtrip"
    })

    const output = schema.toEnhancedJson

    // Verify x-renderer is preserved in output
    expect(output.$defs.Task.properties.priority["x-renderer"]).toBe("priority-badge")
    expect(output.$defs.Task.properties.createdAt["x-renderer"]).toBe("relative-time")
  })

  test("xRenderer works alongside other x-* extensions", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Derived: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            computedCount: {
              type: "number",
              "x-computed": true,
              "x-arktype": "number",
              "x-renderer": "computed-number"
            }
          },
          required: ["id"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-multi-extension"
    })

    const output = schema.toEnhancedJson
    const computedCountProp = output.$defs.Derived.properties.computedCount

    expect(computedCountProp["x-computed"]).toBe(true)
    expect(computedCountProp["x-arktype"]).toBe("number")
    expect(computedCountProp["x-renderer"]).toBe("computed-number")
  })

  test("property without x-renderer has undefined xRenderer", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Simple: {
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
      name: "test-no-renderer"
    })

    const simpleModel = metaStore.modelCollection.all().find(
      (m: any) => m.name === "Simple"
    )
    const nameProperty = metaStore.propertyCollection.all().find(
      (p: any) => p.model === simpleModel && p.name === "name"
    )

    expect(nameProperty.xRenderer).toBeUndefined()

    // toJsonSchema() should not include x-renderer key
    const jsonSchema = nameProperty.toJsonSchema()
    expect(jsonSchema["x-renderer"]).toBeUndefined()
  })
})
