/**
 * removeSchema() Action Tests
 *
 * TDD tests for the removeSchema action that cascade-deletes
 * Schema → Models → Properties → ViewDefinitions from meta-store
 * AND invalidates associated runtime store caches.
 *
 * This enables hot-reload semantics in schema.load.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { getMetaStore, resetMetaStore } from "../bootstrap"
import {
  cacheRuntimeStore,
  getRuntimeStore,
  clearRuntimeStores,
} from "../runtime-store-cache"

describe("removeSchema Action", () => {
  beforeEach(() => {
    resetMetaStore()
    clearRuntimeStores()
  })

  test("removes schema and all related entities (cascade)", () => {
    const metaStore = getMetaStore()

    // Given: Schema with models, properties, and views
    const schema = metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          User: {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
              email: { type: "string" }
            },
            required: ["id", "name"]
          },
          Post: {
            type: "object",
            "x-original-name": "Post",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              title: { type: "string" }
            },
            required: ["id", "title"]
          }
        }
      },
      {
        name: "test-schema",
        views: {
          allUsers: { type: "query", collection: "User" }
        }
      }
    )

    // Verify initial state
    expect(metaStore.schemaCollection.all()).toHaveLength(1)
    expect(metaStore.modelCollection.all()).toHaveLength(2)
    expect(metaStore.propertyCollection.all().length).toBeGreaterThan(0)
    expect(metaStore.viewDefinitionCollection.all()).toHaveLength(1)

    // When: Remove schema
    const removed = metaStore.removeSchema("test-schema")

    // Then: All related entities should be removed
    expect(removed).toBe(true)
    expect(metaStore.schemaCollection.all()).toHaveLength(0)
    expect(metaStore.modelCollection.all()).toHaveLength(0)
    expect(metaStore.propertyCollection.all()).toHaveLength(0)
    expect(metaStore.viewDefinitionCollection.all()).toHaveLength(0)
  })

  test("returns false when schema not found", () => {
    const metaStore = getMetaStore()

    const removed = metaStore.removeSchema("non-existent")

    expect(removed).toBe(false)
  })

  test("only removes specified schema, leaves others intact", () => {
    const metaStore = getMetaStore()

    // Given: Two schemas
    metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          User: {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" }
            }
          }
        }
      },
      { name: "schema-1" }
    )
    metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          Post: {
            type: "object",
            "x-original-name": "Post",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" }
            }
          }
        }
      },
      { name: "schema-2" }
    )

    expect(metaStore.schemaCollection.all()).toHaveLength(2)

    // When: Remove one schema
    metaStore.removeSchema("schema-1")

    // Then: Other schema remains
    expect(metaStore.schemaCollection.all()).toHaveLength(1)
    expect(metaStore.findSchemaByName("schema-2")).toBeDefined()
    expect(metaStore.findSchemaByName("schema-1")).toBeUndefined()

    // And its models remain
    expect(metaStore.modelCollection.all()).toHaveLength(1)
    expect(metaStore.modelCollection.all()[0].name).toBe("Post")
  })

  test("handles nested properties correctly", () => {
    const metaStore = getMetaStore()

    // Given: Schema with nested object property
    metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          User: {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              address: {
                type: "object",
                properties: {
                  street: { type: "string" },
                  city: { type: "string" }
                }
              }
            }
          }
        }
      },
      { name: "nested-schema" }
    )

    const propertyCountBefore = metaStore.propertyCollection.all().length
    expect(propertyCountBefore).toBeGreaterThan(2) // id + address + nested props

    // When: Remove schema
    metaStore.removeSchema("nested-schema")

    // Then: All properties including nested should be removed
    expect(metaStore.propertyCollection.all()).toHaveLength(0)
  })

  test("handles schema with no views", () => {
    const metaStore = getMetaStore()

    // Given: Schema without views
    metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          Task: {
            type: "object",
            "x-original-name": "Task",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" }
            }
          }
        }
      },
      { name: "no-views-schema" }
    )

    expect(metaStore.viewDefinitionCollection.all()).toHaveLength(0)

    // When: Remove schema
    const removed = metaStore.removeSchema("no-views-schema")

    // Then: Should succeed
    expect(removed).toBe(true)
    expect(metaStore.schemaCollection.all()).toHaveLength(0)
  })

  test("handles schema with multiple views", () => {
    const metaStore = getMetaStore()

    // Given: Schema with multiple views
    metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          Task: {
            type: "object",
            "x-original-name": "Task",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              status: { type: "string" }
            }
          }
        }
      },
      {
        name: "multi-view-schema",
        views: {
          allTasks: { type: "query", collection: "Task" },
          pendingTasks: { type: "query", collection: "Task", filter: { status: "pending" } },
          taskReport: { type: "template", dataSource: "allTasks", template: "report.njk" }
        }
      }
    )

    expect(metaStore.viewDefinitionCollection.all()).toHaveLength(3)

    // When: Remove schema
    metaStore.removeSchema("multi-view-schema")

    // Then: All views should be removed
    expect(metaStore.viewDefinitionCollection.all()).toHaveLength(0)
  })
})

describe("removeSchema Runtime Store Cache Invalidation", () => {
  beforeEach(() => {
    resetMetaStore()
    clearRuntimeStores()
  })

  test("invalidates runtime store cache when schema is removed", () => {
    const metaStore = getMetaStore()

    // Given: Schema ingested and runtime store cached
    const schema = metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          Task: {
            type: "object",
            "x-original-name": "Task",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" }
            }
          }
        }
      },
      { name: "cached-schema" }
    )

    // Capture ID before removal (accessing detached MST nodes triggers warnings)
    const schemaId = schema.id

    // Simulate runtime store being cached
    const mockRuntimeStore = { taskCollection: { all: () => [] } }
    cacheRuntimeStore(schemaId, mockRuntimeStore)

    // Verify cache exists
    expect(getRuntimeStore(schemaId)).toBe(mockRuntimeStore)

    // When: Remove schema
    metaStore.removeSchema("cached-schema")

    // Then: Runtime store cache should be invalidated
    expect(getRuntimeStore(schemaId)).toBeUndefined()
  })

  test("invalidates workspace-specific runtime store cache", () => {
    const metaStore = getMetaStore()

    // Given: Schema with runtime stores in multiple workspaces
    const schema = metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          Task: {
            type: "object",
            "x-original-name": "Task",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" }
            }
          }
        }
      },
      { name: "multi-workspace-schema" }
    )

    // Capture ID before removal (accessing detached MST nodes triggers warnings)
    const schemaId = schema.id

    const mockStore1 = { id: "store1" }
    const mockStore2 = { id: "store2" }
    cacheRuntimeStore(schemaId, mockStore1, "/workspace/one")
    cacheRuntimeStore(schemaId, mockStore2, "/workspace/two")

    // Verify both caches exist
    expect(getRuntimeStore(schemaId, "/workspace/one")).toBe(mockStore1)
    expect(getRuntimeStore(schemaId, "/workspace/two")).toBe(mockStore2)

    // When: Remove schema
    metaStore.removeSchema("multi-workspace-schema")

    // Then: All workspace-specific caches should be invalidated
    expect(getRuntimeStore(schemaId, "/workspace/one")).toBeUndefined()
    expect(getRuntimeStore(schemaId, "/workspace/two")).toBeUndefined()
  })

  test("does not affect other schemas' runtime store caches", () => {
    const metaStore = getMetaStore()

    // Given: Two schemas with cached runtime stores
    const schema1 = metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          User: {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" }
            }
          }
        }
      },
      { name: "schema-to-remove" }
    )

    const schema2 = metaStore.ingestEnhancedJsonSchema(
      {
        $defs: {
          Post: {
            type: "object",
            "x-original-name": "Post",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" }
            }
          }
        }
      },
      { name: "schema-to-keep" }
    )

    // Capture IDs before removal (accessing detached MST nodes triggers warnings)
    const schema1Id = schema1.id
    const schema2Id = schema2.id

    const mockStore1 = { id: "store1" }
    const mockStore2 = { id: "store2" }
    cacheRuntimeStore(schema1Id, mockStore1)
    cacheRuntimeStore(schema2Id, mockStore2)

    // When: Remove first schema
    metaStore.removeSchema("schema-to-remove")

    // Then: First schema's cache is invalidated
    expect(getRuntimeStore(schema1Id)).toBeUndefined()

    // But second schema's cache remains
    expect(getRuntimeStore(schema2Id)).toBe(mockStore2)
  })
})
