/**
 * Schema Update Tests (Bug #2 Fix)
 *
 * TDD tests for updating existing schemas via ingestEnhancedJsonSchema().
 *
 * The current implementation has a bug where ingestEnhancedJsonSchema returns
 * the existing schema entity without updating it when called with the same
 * schema name but different content. This blocks schema evolution.
 *
 * The fix should:
 * 1. Use content checksums to detect actual changes
 * 2. Update existing schema models/properties when content differs
 * 3. Preserve idempotency for identical content (React StrictMode safety)
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { getMetaStore, resetMetaStore } from "../bootstrap"
import { clearRuntimeStores } from "../runtime-store-cache"

describe("Schema Update via ingestEnhancedJsonSchema", () => {
  beforeEach(() => {
    resetMetaStore()
    clearRuntimeStores()
  })

  describe("Schema content changes", () => {
    test("updates schema when same name but different models (adds new model)", () => {
      const metaStore = getMetaStore()

      // Given: Initial schema with User model only
      const schemaV1 = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              "x-original-name": "User",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
                name: { type: "string" },
              },
              required: ["id", "name"],
            },
          },
        },
        { name: "test-schema" }
      )

      const initialId = schemaV1.id
      expect(schemaV1.models).toHaveLength(1)
      expect(schemaV1.models[0].name).toBe("User")

      // When: Update with User + Post models
      const schemaV2 = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              "x-original-name": "User",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
                name: { type: "string" },
              },
              required: ["id", "name"],
            },
            Post: {
              type: "object",
              "x-original-name": "Post",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
                title: { type: "string" },
              },
              required: ["id", "title"],
            },
          },
        },
        { name: "test-schema" }
      )

      // Then: Same schema ID but with updated models
      expect(schemaV2.id).toBe(initialId)
      expect(schemaV2.models).toHaveLength(2)
      expect(schemaV2.models.map((m: any) => m.name).sort()).toEqual(["Post", "User"])

      // And: Only one schema in collection
      expect(metaStore.schemaCollection.all()).toHaveLength(1)
    })

    test("updates schema when model properties change", () => {
      const metaStore = getMetaStore()

      // Given: Initial schema with User { id, name }
      const schemaV1 = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              "x-original-name": "User",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
                name: { type: "string" },
              },
              required: ["id", "name"],
            },
          },
        },
        { name: "test-schema" }
      )

      const initialId = schemaV1.id
      const userModelV1 = schemaV1.models.find((m: any) => m.name === "User")
      expect(userModelV1.properties).toHaveLength(2) // id, name

      // When: Update with User { id, name, email }
      const schemaV2 = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              "x-original-name": "User",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
                name: { type: "string" },
                email: { type: "string" },
              },
              required: ["id", "name", "email"],
            },
          },
        },
        { name: "test-schema" }
      )

      // Then: Same schema ID
      expect(schemaV2.id).toBe(initialId)

      // And: User model has 3 properties now
      const userModelV2 = schemaV2.models.find((m: any) => m.name === "User")
      expect(userModelV2.properties).toHaveLength(3)
      expect(userModelV2.properties.map((p: any) => p.name).sort()).toEqual(["email", "id", "name"])
    })

    test("updates schema when model is removed", () => {
      const metaStore = getMetaStore()

      // Given: Initial schema with User and Post models
      const schemaV1 = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              "x-original-name": "User",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
              },
              required: ["id"],
            },
            Post: {
              type: "object",
              "x-original-name": "Post",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
              },
              required: ["id"],
            },
          },
        },
        { name: "test-schema" }
      )

      const initialId = schemaV1.id
      expect(schemaV1.models).toHaveLength(2)

      // When: Update with only User model (Post removed)
      const schemaV2 = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              "x-original-name": "User",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
              },
              required: ["id"],
            },
          },
        },
        { name: "test-schema" }
      )

      // Then: Same schema ID but only User model
      expect(schemaV2.id).toBe(initialId)
      expect(schemaV2.models).toHaveLength(1)
      expect(schemaV2.models[0].name).toBe("User")

      // And: Post model should be gone from modelCollection
      const allModels = metaStore.modelCollection.all()
      expect(allModels.every((m: any) => m.name !== "Post")).toBe(true)
    })
  })

  describe("Idempotency (React StrictMode safety)", () => {
    test("returns existing unchanged when content is identical", () => {
      const metaStore = getMetaStore()

      const schema = {
        $defs: {
          User: {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
        },
      }

      // When: Called twice with identical content
      const result1 = metaStore.ingestEnhancedJsonSchema(schema, { name: "test" })
      const result2 = metaStore.ingestEnhancedJsonSchema(schema, { name: "test" })

      // Then: Same schema ID returned
      expect(result2.id).toBe(result1.id)

      // And: Only one schema in collection (no duplicates)
      expect(metaStore.schemaCollection.all()).toHaveLength(1)

      // And: Only one set of models (no duplicates)
      expect(metaStore.modelCollection.all()).toHaveLength(1)
    })
  })

  describe("Content checksum", () => {
    test("stores contentChecksum on schema entity", () => {
      const metaStore = getMetaStore()

      const schema = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        },
        { name: "test" }
      )

      // Then: contentChecksum should be defined and non-empty
      expect(schema.contentChecksum).toBeDefined()
      expect(typeof schema.contentChecksum).toBe("string")
      expect(schema.contentChecksum.length).toBeGreaterThan(0)
    })

    test("contentChecksum changes when content changes", () => {
      const metaStore = getMetaStore()

      const schema1 = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        },
        { name: "test" }
      )

      const checksum1 = schema1.contentChecksum

      // Update with different content
      const schema2 = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              properties: { email: { type: "string" } },
            },
          },
        },
        { name: "test" }
      )

      // Then: Checksum should have changed
      expect(schema2.contentChecksum).not.toBe(checksum1)
    })

    test("contentChecksum is same for identical content", () => {
      const metaStore = getMetaStore()

      const schema = {
        $defs: {
          User: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      }

      const result1 = metaStore.ingestEnhancedJsonSchema(schema, { name: "test" })
      const checksum1 = result1.contentChecksum

      // Call again with same content
      const result2 = metaStore.ingestEnhancedJsonSchema(schema, { name: "test" })

      // Then: Checksum should be the same
      expect(result2.contentChecksum).toBe(checksum1)
    })
  })

  describe("toEnhancedJson reflects updates", () => {
    test("toEnhancedJson returns updated models after schema update", () => {
      const metaStore = getMetaStore()

      // Given: Initial schema
      metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              "x-original-name": "User",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
              },
              required: ["id"],
            },
          },
        },
        { name: "test-schema" }
      )

      // When: Update with additional property
      const updatedSchema = metaStore.ingestEnhancedJsonSchema(
        {
          $defs: {
            User: {
              type: "object",
              "x-original-name": "User",
              properties: {
                id: { type: "string", "x-mst-type": "identifier" },
                email: { type: "string" },
              },
              required: ["id", "email"],
            },
          },
        },
        { name: "test-schema" }
      )

      // Then: toEnhancedJson should return the updated schema
      const exported = updatedSchema.toEnhancedJson
      expect(exported.$defs.User.properties).toHaveProperty("email")
      expect(Object.keys(exported.$defs.User.properties)).toHaveLength(2)
    })
  })
})
