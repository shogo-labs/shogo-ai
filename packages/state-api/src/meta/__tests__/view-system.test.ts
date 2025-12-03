/**
 * Integration tests for the three-layer view system
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { createMetaStore } from "../meta-store"
import { executeView } from "../view-executor"
import { writeFile, mkdir, rm } from "fs/promises"
import { existsSync } from "fs"

describe("View System Integration", () => {
  let metaStore: any
  let testSchemaId: string

  afterAll(async () => {
    // Clean up test schema directory
    if (existsSync(".schemas/test-schema")) {
      await rm(".schemas/test-schema", { recursive: true })
    }
  })

  beforeEach(async () => {
    // Reset meta-store singleton to ensure fresh state with ViewDefinition collection
    const { resetMetaStore, getMetaStore, clearRuntimeStores } = await import("../bootstrap")
    resetMetaStore()
    clearRuntimeStores()

    // Get fresh meta-store
    metaStore = getMetaStore()

    // Create a test schema with views (using arktype for proper conversion)
    const { scope } = await import("arktype")
    const { arkTypeToEnhancedJsonSchema } = await import("../../schematic/arktype-to-json-schema")

    const TestSchema = scope({
      Task: {
        id: "string",
        title: "string",
        status: "string",
        "assignedTo?": "string"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, "TestSchema")

    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: "test-schema",
      views: {
        // Query view: filter tasks by status
        tasksByStatus: {
          type: "query",
          collection: "Task",
          filter: { status: "${status}" },
          select: ["id", "title", "status"]
        },
        // Query view: all tasks (no filter)
        allTasks: {
          type: "query",
          collection: "Task"
        },
        // Template view: render tasks as markdown
        tasksMarkdown: {
          type: "template",
          dataSource: "tasksByStatus",
          template: "tasks.njk"
        }
      }
    })

    testSchemaId = schema.id

    // Create runtime store from the test schema (not MetaRegistry!)
    const { enhancedJsonSchemaToMST } = await import("../../schematic/index")
    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()

    // Cache runtime store (simulating schema.load flow)
    const { cacheRuntimeStore } = await import("../bootstrap")
    cacheRuntimeStore(testSchemaId, runtimeStore)

    // Add test tasks
    runtimeStore.taskCollection.add({
      id: "task-1",
      title: "Implement views",
      status: "completed",
      assignedTo: "alice"
    })
    runtimeStore.taskCollection.add({
      id: "task-2",
      title: "Write tests",
      status: "in-progress",
      assignedTo: "bob"
    })
    runtimeStore.taskCollection.add({
      id: "task-3",
      title: "Write docs",
      status: "in-progress",
      assignedTo: "alice"
    })

    // Create templates directory and template file
    const templatesDir = `.schemas/test-schema/templates`
    if (!existsSync(templatesDir)) {
      await mkdir(templatesDir, { recursive: true })
    }

    const templateContent = `# Tasks ({{ data.length }})

{% for task in data %}
- [{% if task.status == 'completed' %}x{% else %} {% endif %}] {{ task.title }}
{% endfor %}`

    await writeFile(`${templatesDir}/tasks.njk`, templateContent, "utf-8")
  })

  test("Layer 1: MST base views work correctly", () => {
    const { getRuntimeStore } = require("../bootstrap")
    const runtimeStore = getRuntimeStore(testSchemaId)

    // Test all()
    const allTasks = runtimeStore.taskCollection.all()
    expect(allTasks).toHaveLength(3)

    // Test findById()
    const task1 = runtimeStore.taskCollection.findById("task-1")
    expect(task1?.title).toBe("Implement views")

    // Test findBy()
    const completedTasks = runtimeStore.taskCollection.findBy("status", "completed")
    expect(completedTasks).toHaveLength(1)
    expect(completedTasks[0].title).toBe("Implement views")

    // Test where()
    const aliceTasks = runtimeStore.taskCollection.where({ assignedTo: "alice" })
    expect(aliceTasks).toHaveLength(2)
  })

  test("Layer 2: Query views with parameter substitution", async () => {
    // Execute query view with parameter
    const result = await executeView("test-schema", "tasksByStatus", {
      status: "in-progress"
    })

    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe("Write tests")
    expect(result[1].title).toBe("Write docs")

    // Check field projection (only selected fields)
    expect(result[0]).toHaveProperty("id")
    expect(result[0]).toHaveProperty("title")
    expect(result[0]).toHaveProperty("status")
    expect(result[0]).not.toHaveProperty("assignedTo")
  })

  test("Layer 2: Query view without filter returns all entities", async () => {
    const result = await executeView("test-schema", "allTasks", {})

    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(3)
  })

  test("Layer 3: Template views render correctly", async () => {
    // Execute template view
    const result = await executeView("test-schema", "tasksMarkdown", {
      status: "in-progress"
    })

    expect(typeof result).toBe("string")
    expect(result).toContain("# Tasks (2)")
    expect(result).toContain("[ ] Write tests")
    expect(result).toContain("[ ] Write docs")
  })

  test("Error handling: Missing schema", async () => {
    await expect(executeView("nonexistent", "someView", {})).rejects.toThrow(
      "Schema 'nonexistent' not found"
    )
  })

  test("Error handling: Missing view", async () => {
    await expect(executeView("test-schema", "nonexistent", {})).rejects.toThrow(
      "View 'nonexistent' not found"
    )
  })

  test("Error handling: Missing parameter", async () => {
    await expect(executeView("test-schema", "tasksByStatus", {})).rejects.toThrow(
      "Missing required parameter: status"
    )
  })

  test("Error handling: Runtime store not found", async () => {
    // Clear runtime cache to simulate missing runtime store
    const { removeRuntimeStore } = await import("../bootstrap")
    removeRuntimeStore(testSchemaId)

    await expect(executeView("test-schema", "tasksByStatus", { status: "completed" })).rejects.toThrow(
      "Runtime store not found for schema 'test-schema'"
    )

    // Restore runtime store for remaining tests
    const { enhancedJsonSchemaToMST } = await import("../../schematic/index")
    const { scope } = await import("arktype")
    const { arkTypeToEnhancedJsonSchema } = await import("../../schematic/arktype-to-json-schema")
    const { cacheRuntimeStore } = await import("../bootstrap")

    const TestSchema = scope({
      Task: {
        id: "string",
        title: "string",
        status: "string",
        "assignedTo?": "string"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, "TestSchema")
    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()
    cacheRuntimeStore(testSchemaId, runtimeStore)
  })

  test("Error handling: Collection not found", async () => {
    // Create view with invalid collection name
    const { v4: uuidv4 } = await import("uuid")
    const schema = metaStore.findSchemaByName("test-schema")

    metaStore.viewDefinitionCollection.add({
      id: uuidv4(),
      schema: schema.id,
      name: "invalidCollection",
      type: "query",
      collection: "NonexistentModel"
    })

    await expect(executeView("test-schema", "invalidCollection", {})).rejects.toThrow(
      "Collection 'NonexistentModel' not found in schema 'test-schema'"
    )
  })

  test("Error handling: Template view missing dataSource", async () => {
    // Create template view without dataSource
    const { v4: uuidv4 } = await import("uuid")
    const schema = metaStore.findSchemaByName("test-schema")

    metaStore.viewDefinitionCollection.add({
      id: uuidv4(),
      schema: schema.id,
      name: "noDataSource",
      type: "template",
      template: "some-template.njk"
    })

    await expect(executeView("test-schema", "noDataSource", {})).rejects.toThrow(
      "Template view 'noDataSource' missing dataSource"
    )
  })

  test("Error handling: Template view missing template", async () => {
    // Create template view without template file
    const { v4: uuidv4 } = await import("uuid")
    const schema = metaStore.findSchemaByName("test-schema")

    metaStore.viewDefinitionCollection.add({
      id: uuidv4(),
      schema: schema.id,
      name: "noTemplate",
      type: "template",
      dataSource: "allTasks"
    })

    await expect(executeView("test-schema", "noTemplate", {})).rejects.toThrow(
      "Template view 'noTemplate' missing template"
    )
  })

  test("Error handling: Template file not found on disk", async () => {
    // Create template view with non-existent template file
    const { v4: uuidv4 } = await import("uuid")
    const schema = metaStore.findSchemaByName("test-schema")

    metaStore.viewDefinitionCollection.add({
      id: uuidv4(),
      schema: schema.id,
      name: "missingFile",
      type: "template",
      dataSource: "allTasks",
      template: "nonexistent.njk"
    })

    await expect(executeView("test-schema", "missingFile", {})).rejects.toThrow(
      /Template rendering failed.*template not found/
    )
  })

  test("Error handling: Malformed template syntax", async () => {
    // Create a template with invalid Nunjucks syntax
    const { v4: uuidv4 } = await import("uuid")
    const { writeFile } = await import("fs/promises")
    const schema = metaStore.findSchemaByName("test-schema")

    const templatesDir = `.schemas/test-schema/templates`
    await writeFile(`${templatesDir}/malformed.njk`, "{% for item in data %} Missing endfor", "utf-8")

    metaStore.viewDefinitionCollection.add({
      id: uuidv4(),
      schema: schema.id,
      name: "malformedTemplate",
      type: "template",
      dataSource: "allTasks",
      template: "malformed.njk"
    })

    await expect(executeView("test-schema", "malformedTemplate", {})).rejects.toThrow(
      /Template rendering failed/
    )
  })

  test("View metadata is persisted correctly", () => {
    const schema = metaStore.findSchemaByName("test-schema")
    expect(schema.views).toHaveLength(3)

    // Check viewsMetadata view
    const viewsMetadata = schema.viewsMetadata
    expect(viewsMetadata).toHaveProperty("tasksByStatus")
    expect(viewsMetadata.tasksByStatus.type).toBe("query")
    expect(viewsMetadata.tasksByStatus.collection).toBe("Task")
  })
})
