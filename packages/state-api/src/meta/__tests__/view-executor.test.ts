/**
 * Unit Tests: view-executor.ts
 *
 * Tests the core view execution functions:
 * - substituteParams() - parameter substitution logic
 * - executeQueryView() - query view execution
 * - executeTemplateView() - template view execution
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { executeView } from "../view-executor"
import { rm } from "fs/promises"
import { existsSync } from "fs"

// Cleanup all test schemas after all tests complete
afterAll(async () => {
  const schemas = [
    ".schemas/param-test-schema",
    ".schemas/query-test-schema",
    ".schemas/template-test-schema",
    ".schemas/error-test-schema"
  ]

  for (const schema of schemas) {
    if (existsSync(schema)) {
      await rm(schema, { recursive: true })
    }
  }
})

describe("View Executor - Parameter Substitution", () => {
  let schemaId: string

  beforeEach(async () => {
    const { resetMetaStore, getMetaStore, clearRuntimeStores, cacheRuntimeStore } = await import("../bootstrap")
    const { scope } = await import("arktype")
    const { arkTypeToEnhancedJsonSchema } = await import("../../schematic/arktype-to-json-schema")
    const { enhancedJsonSchemaToMST } = await import("../../schematic/index")

    resetMetaStore()
    clearRuntimeStores()

    const TestSchema = scope({
      Item: {
        id: "string",
        name: "string",
        category: "string",
        priority: "number"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, "param-test-schema")
    const metaStore = getMetaStore()
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "param-test-schema",
      views: {
        // Single parameter
        singleParam: {
          type: "query",
          collection: "Item",
          filter: { category: "${cat}" }
        },
        // Multiple parameters
        multiParam: {
          type: "query",
          collection: "Item",
          filter: { category: "${cat}", priority: "${pri}" }
        },
        // Mixed: parameter and literal
        mixedFilter: {
          type: "query",
          collection: "Item",
          filter: { category: "${cat}", name: "fixed-name" }
        }
      }
    })

    schemaId = schema.id

    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()
    cacheRuntimeStore(schemaId, runtimeStore)

    // Add test data
    runtimeStore.itemCollection.add({ id: "1", name: "Item A", category: "tools", priority: 1 })
    runtimeStore.itemCollection.add({ id: "2", name: "Item B", category: "books", priority: 2 })
    runtimeStore.itemCollection.add({ id: "3", name: "Item C", category: "tools", priority: 3 })
  })

  test("Single parameter substitution", async () => {
    const result = await executeView("param-test-schema", "singleParam", { cat: "tools" })
    expect(result).toHaveLength(2)
    expect(result[0].category).toBe("tools")
    expect(result[1].category).toBe("tools")
  })

  test("Multiple parameter substitution", async () => {
    const result = await executeView("param-test-schema", "multiParam", { cat: "tools", pri: 1 })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("1")
  })

  test("Mixed filter: parameter + literal", async () => {
    const { getRuntimeStore } = await import("../bootstrap")
    const runtimeStore = getRuntimeStore(schemaId)

    // Add item with matching name
    runtimeStore.itemCollection.add({ id: "4", name: "fixed-name", category: "tools", priority: 4 })

    const result = await executeView("param-test-schema", "mixedFilter", { cat: "tools" })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("fixed-name")
  })

  test("Missing required parameter throws error", async () => {
    await expect(
      executeView("param-test-schema", "singleParam", {})
    ).rejects.toThrow("Missing required parameter: cat")
  })

  test("Non-string filter values pass through unchanged", async () => {
    // The multiParam view has priority as a number parameter
    const result = await executeView("param-test-schema", "multiParam", { cat: "books", pri: 2 })
    expect(result).toHaveLength(1)
    expect(result[0].priority).toBe(2)
  })
})

describe("View Executor - Query View Execution", () => {
  let schemaId: string

  beforeEach(async () => {
    const { resetMetaStore, getMetaStore, clearRuntimeStores, cacheRuntimeStore } = await import("../bootstrap")
    const { scope } = await import("arktype")
    const { arkTypeToEnhancedJsonSchema } = await import("../../schematic/arktype-to-json-schema")
    const { enhancedJsonSchemaToMST } = await import("../../schematic/index")

    resetMetaStore()
    clearRuntimeStores()

    const TestSchema = scope({
      Product: {
        id: "string",
        name: "string",
        price: "number",
        inStock: "boolean"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, "query-test-schema")
    const metaStore = getMetaStore()
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "query-test-schema",
      views: {
        // With filter
        inStockProducts: {
          type: "query",
          collection: "Product",
          filter: { inStock: "${inStock}" }
        },
        // No filter (all records)
        allProducts: {
          type: "query",
          collection: "Product"
        },
        // With field projection
        productNames: {
          type: "query",
          collection: "Product",
          filter: { inStock: "${inStock}" },
          select: ["id", "name"]
        }
      }
    })

    schemaId = schema.id

    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()
    cacheRuntimeStore(schemaId, runtimeStore)

    // Add test data
    runtimeStore.productCollection.add({ id: "p1", name: "Widget", price: 10, inStock: true })
    runtimeStore.productCollection.add({ id: "p2", name: "Gadget", price: 20, inStock: false })
    runtimeStore.productCollection.add({ id: "p3", name: "Doohickey", price: 30, inStock: true })
  })

  test("Query with filter uses where() base view", async () => {
    const result = await executeView("query-test-schema", "inStockProducts", { inStock: true })
    expect(result).toHaveLength(2)
    expect(result.every((p: any) => p.inStock === true)).toBe(true)
  })

  test("Query without filter uses all() base view", async () => {
    const result = await executeView("query-test-schema", "allProducts", {})
    expect(result).toHaveLength(3)
  })

  test("Field projection returns only selected fields", async () => {
    const result = await executeView("query-test-schema", "productNames", { inStock: true })
    expect(result).toHaveLength(2)
    expect(result[0]).toHaveProperty("id")
    expect(result[0]).toHaveProperty("name")
    expect(result[0]).not.toHaveProperty("price")
    expect(result[0]).not.toHaveProperty("inStock")
  })

  test("Empty result set returns empty array", async () => {
    const result = await executeView("query-test-schema", "inStockProducts", { inStock: "nonexistent" })
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  test("Collection name resolution: camelCase conversion", async () => {
    // Product → productCollection (camelCase)
    // This is tested implicitly by all tests - if it failed, they'd all fail
    const result = await executeView("query-test-schema", "allProducts", {})
    expect(result).toHaveLength(3)
  })
})

describe("View Executor - Template View Execution", () => {
  beforeEach(async () => {
    const { resetMetaStore, getMetaStore, clearRuntimeStores, cacheRuntimeStore } = await import("../bootstrap")
    const { scope } = await import("arktype")
    const { arkTypeToEnhancedJsonSchema } = await import("../../schematic/arktype-to-json-schema")
    const { enhancedJsonSchemaToMST } = await import("../../schematic/index")
    const { saveSchema } = await import("../../persistence")
    const { mkdir } = await import("fs/promises")
    const { existsSync } = await import("fs")

    resetMetaStore()
    clearRuntimeStores()

    const TestSchema = scope({
      Article: {
        id: "string",
        title: "string",
        author: "string"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, "template-test-schema")
    const metaStore = getMetaStore()
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "template-test-schema",
      views: {
        articlesByAuthor: {
          type: "query",
          collection: "Article",
          filter: { author: "${author}" }
        },
        articleList: {
          type: "template",
          dataSource: "articlesByAuthor",
          template: "list.njk"
        }
      }
    })

    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()
    cacheRuntimeStore(schema.id, runtimeStore)

    // Add test data
    runtimeStore.articleCollection.add({ id: "a1", title: "Article 1", author: "Alice" })
    runtimeStore.articleCollection.add({ id: "a2", title: "Article 2", author: "Bob" })
    runtimeStore.articleCollection.add({ id: "a3", title: "Article 3", author: "Alice" })

    // Create template
    const templatesDir = ".schemas/template-test-schema/templates"
    if (!existsSync(templatesDir)) {
      await mkdir(templatesDir, { recursive: true })
    }
    await saveSchema(schema, {
      "list.njk": `Articles by {{ data[0].author if data.length > 0 else "Unknown" }}:
{% for article in data %}
- {{ article.title }}
{% endfor %}`
    })
  })

  test("Template view renders with data from query view", async () => {
    const result = await executeView("template-test-schema", "articleList", { author: "Alice" })

    expect(typeof result).toBe("string")
    expect(result).toContain("Articles by Alice")
    expect(result).toContain("- Article 1")
    expect(result).toContain("- Article 3")
  })

  test("Template view with empty data renders correctly", async () => {
    const result = await executeView("template-test-schema", "articleList", { author: "Charlie" })

    expect(typeof result).toBe("string")
    expect(result).toContain("Articles by Unknown")
  })
})

describe("View Executor - Error Handling", () => {
  beforeEach(async () => {
    const { resetMetaStore, getMetaStore, clearRuntimeStores, cacheRuntimeStore } = await import("../bootstrap")
    const { scope } = await import("arktype")
    const { arkTypeToEnhancedJsonSchema } = await import("../../schematic/arktype-to-json-schema")
    const { enhancedJsonSchemaToMST } = await import("../../schematic/index")

    resetMetaStore()
    clearRuntimeStores()

    const TestSchema = scope({
      Record: {
        id: "string",
        data: "string"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, "error-test-schema")
    const metaStore = getMetaStore()
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "error-test-schema",
      views: {
        testView: {
          type: "query",
          collection: "Record"
        }
      }
    })

    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()
    cacheRuntimeStore(schema.id, runtimeStore)
  })

  test("Missing schema throws error", async () => {
    await expect(
      executeView("nonexistent-schema", "testView", {})
    ).rejects.toThrow("Schema 'nonexistent-schema' not found")
  })

  test("Missing view throws error", async () => {
    await expect(
      executeView("error-test-schema", "nonexistent-view", {})
    ).rejects.toThrow("View 'nonexistent-view' not found")
  })

  test("Invalid view type is prevented by schema validation", async () => {
    const { getMetaStore } = await import("../bootstrap")
    const { v4: uuidv4 } = await import("uuid")

    const metaStore = getMetaStore()
    const schema = metaStore.findSchemaByName("error-test-schema")

    // Attempting to create a view with invalid type should fail at MST validation
    expect(() => {
      metaStore.viewDefinitionCollection.add({
        id: uuidv4(),
        schema: schema.id,
        name: "invalidView",
        type: "invalid" as any,
        collection: "Record"
      })
    }).toThrow()  // MST validation prevents invalid types from being created
  })
})
