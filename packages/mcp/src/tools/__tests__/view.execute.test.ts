/**
 * MCP Tool Tests: view.execute
 *
 * Tests the MCP tool wrapper for view execution, including:
 * - JSON response format
 * - Error serialization
 * - Parameter validation
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { rm } from "fs/promises"
import { existsSync } from "fs"

// TODO: Re-enable when ../../../meta/bootstrap module path is fixed
describe.skip("view.execute MCP Tool", () => {
  let executeFunction: any

  afterAll(async () => {
    // Clean up test schema directory
    if (existsSync(".schemas/test-mcp-schema")) {
      await rm(".schemas/test-mcp-schema", { recursive: true })
    }
  })

  beforeEach(async () => {
    // Setup test schema with views
    const { resetMetaStore, getMetaStore, clearRuntimeStores, cacheRuntimeStore } = await import("../../../meta/bootstrap")
    const { scope } = await import("arktype")
    const { arkTypeToEnhancedJsonSchema } = await import("../../../schematic/arktype-to-json-schema")
    const { enhancedJsonSchemaToMST } = await import("../../../schematic/index")
    const { saveSchema } = await import("../../../persistence")
    const { mkdir, writeFile } = await import("fs/promises")
    const { existsSync } = await import("fs")

    resetMetaStore()
    clearRuntimeStores()

    // Create test schema
    const TestSchema = scope({
      Task: {
        id: "string",
        title: "string",
        status: "'pending' | 'completed'"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, "test-mcp-schema")

    const metaStore = getMetaStore()
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "test-mcp-schema",
      views: {
        completedTasks: {
          type: "query",
          collection: "Task",
          filter: { status: "${status}" }
        },
        taskSummary: {
          type: "template",
          dataSource: "completedTasks",
          template: "summary.njk"
        }
      }
    })

    // Create runtime store
    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()
    cacheRuntimeStore(schema.id, runtimeStore)

    // Add test data
    runtimeStore.taskCollection.add({
      id: "task-1",
      title: "Task 1",
      status: "completed"
    })
    runtimeStore.taskCollection.add({
      id: "task-2",
      title: "Task 2",
      status: "pending"
    })

    // Create template
    const templatesDir = ".schemas/test-mcp-schema/templates"
    if (!existsSync(templatesDir)) {
      await mkdir(templatesDir, { recursive: true })
    }
    await saveSchema(schema, {
      "summary.njk": `Tasks: {{ data.length }}`
    })

    // Create mock server to capture the execute function
    const { registerViewExecute } = await import("../view.execute")
    const mockServer: any = {
      addTool: (config: any) => {
        executeFunction = config.execute
      }
    }
    registerViewExecute(mockServer)
  })

  test("Query view: successful execution returns JSON with array result", async () => {
    const result = await executeFunction({
      schema: "test-mcp-schema",
      view: "completedTasks",
      params: { status: "completed" }
    })

    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(true)
    expect(parsed.view).toEqual({
      schema: "test-mcp-schema",
      name: "completedTasks",
      type: "query"
    })
    expect(Array.isArray(parsed.result)).toBe(true)
    expect(parsed.result).toHaveLength(1)
    expect(parsed.metadata.resultType).toBe("array")
    expect(parsed.metadata.count).toBe(1)
  })

  test("Template view: successful execution returns JSON with string result", async () => {
    const result = await executeFunction({
      schema: "test-mcp-schema",
      view: "taskSummary",
      params: { status: "completed" }
    })

    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(true)
    expect(parsed.view).toEqual({
      schema: "test-mcp-schema",
      name: "taskSummary",
      type: "template"
    })
    expect(typeof parsed.result).toBe("string")
    expect(parsed.result).toContain("Tasks: 1")
    expect(parsed.metadata.resultType).toBe("string")
    expect(parsed.metadata.count).toBeUndefined()
  })

  test("Error: missing schema returns structured error", async () => {
    const result = await executeFunction({
      schema: "nonexistent",
      view: "someView",
      params: {}
    })

    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("VIEW_EXECUTION_ERROR")
    expect(parsed.error.message).toContain("Schema 'nonexistent' not found")
  })

  test("Error: missing view returns structured error", async () => {
    const result = await executeFunction({
      schema: "test-mcp-schema",
      view: "nonexistent",
      params: {}
    })

    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("VIEW_EXECUTION_ERROR")
    expect(parsed.error.message).toContain("View 'nonexistent' not found")
  })

  test("Error: missing required parameter returns structured error", async () => {
    const result = await executeFunction({
      schema: "test-mcp-schema",
      view: "completedTasks",
      params: {}  // Missing status parameter
    })

    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("VIEW_EXECUTION_ERROR")
    expect(parsed.error.message).toContain("Missing required parameter: status")
  })

  test("Optional params parameter defaults to empty object", async () => {
    // Create a view without parameters
    const { getMetaStore } = await import("../../../meta/bootstrap")
    const { v4: uuidv4 } = await import("uuid")

    const metaStore = getMetaStore()
    const schema = metaStore.findSchemaByName("test-mcp-schema")

    metaStore.viewDefinitionCollection.add({
      id: uuidv4(),
      schema: schema.id,
      name: "allTasks",
      type: "query",
      collection: "Task"
    })

    const result = await executeFunction({
      schema: "test-mcp-schema",
      view: "allTasks"
      // No params field
    })

    const parsed = JSON.parse(result)

    expect(parsed.ok).toBe(true)
    expect(Array.isArray(parsed.result)).toBe(true)
    expect(parsed.result).toHaveLength(2)
  })
})
