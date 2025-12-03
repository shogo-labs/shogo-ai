/**
 * Bootstrap Module Tests
 *
 * Tests for meta-store singleton and runtime store cache management.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import {
  getMetaStore,
  resetMetaStore,
  getRuntimeStore,
  cacheRuntimeStore,
  clearRuntimeStores,
  getCachedSchemaIds,
  removeRuntimeStore
} from "../bootstrap"

describe("Meta-Store Singleton", () => {
  beforeEach(() => {
    resetMetaStore()
  })

  test("creates singleton meta-store on first call", () => {
    const metaStore = getMetaStore()
    expect(metaStore).toBeDefined()
    expect(metaStore.schemaCollection).toBeDefined()
    expect(metaStore.modelCollection).toBeDefined()
    expect(metaStore.propertyCollection).toBeDefined()
    expect(metaStore.viewDefinitionCollection).toBeDefined()
  })

  test("returns same instance on subsequent calls", () => {
    const first = getMetaStore()
    const second = getMetaStore()
    expect(first).toBe(second)
  })

  test("resetMetaStore creates new instance", () => {
    const first = getMetaStore()
    resetMetaStore()
    const second = getMetaStore()
    expect(first).not.toBe(second)
  })

  test("meta-store has ingestEnhancedJsonSchema action", () => {
    const metaStore = getMetaStore()
    expect(typeof metaStore.ingestEnhancedJsonSchema).toBe("function")
  })

  test("meta-store can ingest a simple schema", () => {
    const metaStore = getMetaStore()
    const enhancedSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" }
          },
          required: ["id", "name"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "test-user-schema"
    })

    expect(schema).toBeDefined()
    expect(schema.id).toBeDefined()
    expect(metaStore.schemaCollection.all()).toHaveLength(1)
    expect(metaStore.modelCollection.all()).toHaveLength(1)
    expect(metaStore.propertyCollection.all()).toHaveLength(2)
  })
})

describe("Runtime Store Cache", () => {
  beforeEach(() => {
    clearRuntimeStores()
  })

  test("getRuntimeStore returns undefined for non-existent schema", () => {
    const store = getRuntimeStore("non-existent-id")
    expect(store).toBeUndefined()
  })

  test("cacheRuntimeStore stores a runtime store", () => {
    const mockStore = { userCollection: {}, postCollection: {} }
    cacheRuntimeStore("schema-123", mockStore)

    const retrieved = getRuntimeStore("schema-123")
    expect(retrieved).toBe(mockStore)
  })

  test("cacheRuntimeStore overwrites existing entry", () => {
    const first = { userCollection: {} }
    const second = { userCollection: {}, postCollection: {} }

    cacheRuntimeStore("schema-123", first)
    cacheRuntimeStore("schema-123", second)

    const retrieved = getRuntimeStore("schema-123")
    expect(retrieved).toBe(second)
  })

  test("clearRuntimeStores removes all cached stores", () => {
    cacheRuntimeStore("schema-1", { userCollection: {} })
    cacheRuntimeStore("schema-2", { postCollection: {} })

    expect(getCachedSchemaIds()).toHaveLength(2)

    clearRuntimeStores()

    expect(getCachedSchemaIds()).toHaveLength(0)
    expect(getRuntimeStore("schema-1")).toBeUndefined()
    expect(getRuntimeStore("schema-2")).toBeUndefined()
  })

  test("getCachedSchemaIds returns all cached schema IDs", () => {
    cacheRuntimeStore("schema-1", {})
    cacheRuntimeStore("schema-2", {})
    cacheRuntimeStore("schema-3", {})

    const ids = getCachedSchemaIds()
    expect(ids).toHaveLength(3)
    expect(ids).toContain("schema-1")
    expect(ids).toContain("schema-2")
    expect(ids).toContain("schema-3")
  })

  test("removeRuntimeStore removes specific entry", () => {
    cacheRuntimeStore("schema-1", {})
    cacheRuntimeStore("schema-2", {})

    const removed = removeRuntimeStore("schema-1")

    expect(removed).toBe(true)
    expect(getRuntimeStore("schema-1")).toBeUndefined()
    expect(getRuntimeStore("schema-2")).toBeDefined()
    expect(getCachedSchemaIds()).toHaveLength(1)
  })

  test("removeRuntimeStore returns false for non-existent entry", () => {
    const removed = removeRuntimeStore("non-existent")
    expect(removed).toBe(false)
  })
})

describe("Integration: Meta-Store and Runtime Cache", () => {
  beforeEach(() => {
    resetMetaStore()
    clearRuntimeStores()
  })

  test("meta-store and runtime cache work independently", () => {
    // Create schema in meta-store
    const metaStore = getMetaStore()
    const enhancedSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" }
          }
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "integration-test-schema"
    })

    // Cache a runtime store for this schema
    const mockRuntimeStore = { userCollection: { items: new Map() } }
    cacheRuntimeStore(schema.id, mockRuntimeStore)

    // Verify both systems work
    expect(metaStore.schemaCollection.all()).toHaveLength(1)
    expect(getCachedSchemaIds()).toHaveLength(1)
    expect(getRuntimeStore(schema.id)).toBe(mockRuntimeStore)
  })

  test("can reset meta-store without affecting runtime cache", () => {
    const metaStore = getMetaStore()
    const enhancedSchema = {
      $defs: {
        User: { type: "object", properties: { id: { type: "string" } } }
      }
    }
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "reset-test-schema"
    })

    cacheRuntimeStore(schema.id, { userCollection: {} })

    resetMetaStore()

    // Meta-store reset, but cache unchanged
    const newMetaStore = getMetaStore()
    expect(newMetaStore).not.toBe(metaStore)
    expect(newMetaStore.schemaCollection.all()).toHaveLength(0)
    expect(getRuntimeStore(schema.id)).toBeDefined()
  })

  test("can clear runtime cache without affecting meta-store", () => {
    const metaStore = getMetaStore()
    const enhancedSchema = {
      $defs: {
        User: { type: "object", properties: { id: { type: "string" } } }
      }
    }
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "clear-cache-test-schema"
    })

    cacheRuntimeStore(schema.id, { userCollection: {} })

    clearRuntimeStores()

    // Cache cleared, but meta-store unchanged
    expect(metaStore.schemaCollection.all()).toHaveLength(1)
    expect(getCachedSchemaIds()).toHaveLength(0)
  })
})
