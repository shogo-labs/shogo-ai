/**
 * MCP Tool Tests: view.project
 *
 * Tests the MCP tool for projecting views to disk, including:
 * - Query view projection (writes JSON)
 * - Template view projection (writes rendered text)
 * - Directory creation
 * - Error handling
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { rm, readFile } from "fs/promises"
import { existsSync } from "fs"

// TODO: Re-enable when ../../../meta/bootstrap module path is fixed
describe.skip("view.project MCP Tool", () => {
  let executeFunction: any
  const TEST_OUTPUT_DIR = ".test-projections"

  afterAll(async () => {
    // Clean up test schema and output directory
    if (existsSync(".schemas/test-projection-schema")) {
      await rm(".schemas/test-projection-schema", { recursive: true })
    }
    if (existsSync(TEST_OUTPUT_DIR)) {
      await rm(TEST_OUTPUT_DIR, { recursive: true })
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
      Module: {
        id: "string",
        name: "string",
        status: "'draft' | 'complete'"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, "test-projection-schema")

    const metaStore = getMetaStore()
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "test-projection-schema",
      views: {
        // Query view: returns array
        modulesByStatus: {
          type: "query",
          collection: "Module",
          filter: { status: "${status}" }
        },
        // Template view: renders text
        moduleReport: {
          type: "template",
          dataSource: "modulesByStatus",
          template: "report.njk"
        }
      }
    })

    // Create runtime store
    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()
    cacheRuntimeStore(schema.id, runtimeStore)

    // Add test data
    runtimeStore.moduleCollection.add({
      id: "mod-1",
      name: "Authentication",
      status: "complete"
    })
    runtimeStore.moduleCollection.add({
      id: "mod-2",
      name: "Authorization",
      status: "draft"
    })
    runtimeStore.moduleCollection.add({
      id: "mod-3",
      name: "User Management",
      status: "complete"
    })

    // Create template
    const templatesDir = ".schemas/test-projection-schema/templates"
    if (!existsSync(templatesDir)) {
      await mkdir(templatesDir, { recursive: true })
    }
    await saveSchema(schema, {
      "report.njk": `# Modules Report

Total: {{ data.length }}

{% for module in data %}
- {{ module.name }} ({{ module.id }})
{% endfor %}`
    })

    // Create mock server to capture the execute function
    const { registerViewProject } = await import("../view.project")
    const mockServer: any = {
      addTool: (config: any) => {
        executeFunction = config.execute
      }
    }
    registerViewProject(mockServer)
  })

  test("Query view: projects JSON array to disk", async () => {
    const outputPath = `${TEST_OUTPUT_DIR}/modules-complete.json`

    const result = await executeFunction({
      schema: "test-projection-schema",
      view: "modulesByStatus",
      params: { status: "complete" },
      output_path: outputPath
    })

    const parsed = JSON.parse(result)

    // Verify response
    expect(parsed.ok).toBe(true)
    expect(parsed.view.schema).toBe("test-projection-schema")
    expect(parsed.view.name).toBe("modulesByStatus")
    expect(parsed.view.type).toBe("query")
    expect(parsed.projection.output_path).toBe(outputPath)
    expect(parsed.projection.format).toBe("json")
    expect(parsed.projection.bytes_written).toBeGreaterThan(0)
    expect(parsed.metadata.entity_count).toBe(2)

    // Verify file exists
    expect(existsSync(outputPath)).toBe(true)

    // Verify file content
    const fileContent = await readFile(outputPath, 'utf-8')
    const data = JSON.parse(fileContent)
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(2)
    expect(data[0].name).toBe("Authentication")
    expect(data[1].name).toBe("User Management")
  })

  test("Template view: projects rendered text to disk", async () => {
    const outputPath = `${TEST_OUTPUT_DIR}/modules-report.md`

    const result = await executeFunction({
      schema: "test-projection-schema",
      view: "moduleReport",
      params: { status: "complete" },
      output_path: outputPath
    })

    const parsed = JSON.parse(result)

    // Verify response
    expect(parsed.ok).toBe(true)
    expect(parsed.view.type).toBe("template")
    expect(parsed.projection.format).toBe("text")
    expect(parsed.projection.preview).toContain("# Modules Report")

    // Verify file exists and content
    expect(existsSync(outputPath)).toBe(true)
    const fileContent = await readFile(outputPath, 'utf-8')
    expect(fileContent).toContain("# Modules Report")
    expect(fileContent).toContain("Total: 2")
    expect(fileContent).toContain("- Authentication (mod-1)")
    expect(fileContent).toContain("- User Management (mod-3)")
  })

  test("Directory creation: ensure_directory creates parent directories", async () => {
    const outputPath = `${TEST_OUTPUT_DIR}/nested/deep/modules.json`

    const result = await executeFunction({
      schema: "test-projection-schema",
      view: "modulesByStatus",
      params: { status: "complete" },
      output_path: outputPath,
      ensure_directory: true  // Explicit true
    })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(existsSync(outputPath)).toBe(true)
    expect(existsSync(`${TEST_OUTPUT_DIR}/nested/deep`)).toBe(true)
  })

  test("Directory creation: ensure_directory defaults to true", async () => {
    const outputPath = `${TEST_OUTPUT_DIR}/auto-created/modules.json`

    const result = await executeFunction({
      schema: "test-projection-schema",
      view: "modulesByStatus",
      params: { status: "complete" },
      output_path: outputPath
      // ensure_directory not specified, should default to true
    })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(existsSync(outputPath)).toBe(true)
  })

  test("Error: missing schema returns structured error", async () => {
    const result = await executeFunction({
      schema: "nonexistent",
      view: "someView",
      params: {},
      output_path: `${TEST_OUTPUT_DIR}/error.json`
    })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("VIEW_PROJECTION_ERROR")
    expect(parsed.error.message).toContain("Schema 'nonexistent' not found")
    expect(parsed.error.output_path).toBe(`${TEST_OUTPUT_DIR}/error.json`)
  })

  test("Error: missing view returns structured error", async () => {
    const result = await executeFunction({
      schema: "test-projection-schema",
      view: "nonexistent",
      params: {},
      output_path: `${TEST_OUTPUT_DIR}/error.json`
    })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("VIEW_PROJECTION_ERROR")
    expect(parsed.error.message).toContain("View 'nonexistent' not found")
  })

  test("Error: missing required parameter returns structured error", async () => {
    const result = await executeFunction({
      schema: "test-projection-schema",
      view: "modulesByStatus",
      params: {},  // Missing status parameter
      output_path: `${TEST_OUTPUT_DIR}/error.json`
    })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.message).toContain("Missing required parameter: status")
  })

  test("Projection overwrites existing files", async () => {
    const outputPath = `${TEST_OUTPUT_DIR}/overwrite-test.json`

    // First projection
    const result1 = await executeFunction({
      schema: "test-projection-schema",
      view: "modulesByStatus",
      params: { status: "complete" },
      output_path: outputPath
    })
    expect(JSON.parse(result1).ok).toBe(true)

    const content1 = await readFile(outputPath, 'utf-8')
    const data1 = JSON.parse(content1)
    expect(data1).toHaveLength(2)

    // Second projection with different filter
    const result2 = await executeFunction({
      schema: "test-projection-schema",
      view: "modulesByStatus",
      params: { status: "draft" },
      output_path: outputPath
    })
    expect(JSON.parse(result2).ok).toBe(true)

    // Verify file was overwritten
    const content2 = await readFile(outputPath, 'utf-8')
    const data2 = JSON.parse(content2)
    expect(data2).toHaveLength(1)
    expect(data2[0].name).toBe("Authorization")
  })

  test("Response includes helpful metadata", async () => {
    const outputPath = `${TEST_OUTPUT_DIR}/metadata-test.json`

    const result = await executeFunction({
      schema: "test-projection-schema",
      view: "modulesByStatus",
      params: { status: "complete" },
      output_path: outputPath
    })

    const parsed = JSON.parse(result)

    // Check all expected metadata fields
    expect(parsed.projection).toHaveProperty("output_path")
    expect(parsed.projection).toHaveProperty("bytes_written")
    expect(parsed.projection).toHaveProperty("format")
    expect(parsed.projection).toHaveProperty("preview")
    expect(parsed.metadata).toHaveProperty("timestamp")
    expect(parsed.metadata).toHaveProperty("entity_count")

    // Verify preview is substring of actual content
    const fileContent = await readFile(outputPath, 'utf-8')
    expect(fileContent).toContain(parsed.projection.preview.substring(0, 50))
  })
})
