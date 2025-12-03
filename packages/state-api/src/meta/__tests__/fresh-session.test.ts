/**
 * Fresh Session Integration Test
 *
 * Validates that schemas with views and templates persist correctly
 * and work in a fresh session after save/load cycle.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { executeView } from "../view-executor"
import { existsSync } from "fs"
import { rm } from "fs/promises"

describe("Fresh Session Workflow", () => {
  const TEST_SCHEMA_NAME = "fresh-session-test"
  const TEST_SCHEMA_DIR = `.schemas/${TEST_SCHEMA_NAME}`

  afterEach(async () => {
    // Clean up test schema directory
    if (existsSync(TEST_SCHEMA_DIR)) {
      await rm(TEST_SCHEMA_DIR, { recursive: true })
    }
  })

  test("Full workflow: schema.set → save → reset → load → view.execute", async () => {
    // =====================================================
    // PART 1: Initial Session - Create Schema with Views + Templates
    // =====================================================

    const { resetMetaStore, getMetaStore, clearRuntimeStores, cacheRuntimeStore } = await import("../bootstrap")
    const { saveSchema } = await import("../../persistence")
    const { scope } = await import("arktype")
    const { arkTypeToEnhancedJsonSchema } = await import("../../schematic/arktype-to-json-schema")
    const { enhancedJsonSchemaToMST } = await import("../../schematic/index")
    const { writeFile, mkdir } = await import("fs/promises")

    // Reset to clean state
    resetMetaStore()
    clearRuntimeStores()

    // Create test schema using arktype
    const TestSchema = scope({
      Task: {
        id: "string",
        title: "string",
        status: "'pending' | 'completed'",
        "priority?": "'high' | 'medium' | 'low'"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, TEST_SCHEMA_NAME)

    // Define views
    const views = {
      highPriorityTasks: {
        type: "query",
        collection: "Task",
        filter: { priority: "high" },
        select: ["id", "title", "priority"]
      },
      taskReport: {
        type: "template",
        dataSource: "highPriorityTasks",
        template: "report.njk"
      }
    }

    // Template content
    const templates = {
      "report.njk": `# High Priority Tasks

Total: {{ data.length }}

{% for task in data %}
- {{ task.title }} (ID: {{ task.id }})
{% endfor %}`
    }

    // Ingest schema with views (simulating schema.set)
    const metaStore = getMetaStore()
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: TEST_SCHEMA_NAME,
      views
    })

    // Create runtime store
    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()
    cacheRuntimeStore(schema.id, runtimeStore)

    // Save schema to disk first (this creates the templates directory)
    await saveSchema(schema, templates)

    // Verify files were created
    expect(existsSync(`${TEST_SCHEMA_DIR}/schema.json`)).toBe(true)
    expect(existsSync(`${TEST_SCHEMA_DIR}/templates/report.njk`)).toBe(true)

    // Add test data
    runtimeStore.taskCollection.add({
      id: "task-1",
      title: "Fix critical bug",
      status: "pending",
      priority: "high"
    })
    runtimeStore.taskCollection.add({
      id: "task-2",
      title: "Write documentation",
      status: "completed",
      priority: "medium"
    })
    runtimeStore.taskCollection.add({
      id: "task-3",
      title: "Security audit",
      status: "pending",
      priority: "high"
    })

    // Test views work in initial session
    const queryResult = await executeView(TEST_SCHEMA_NAME, "highPriorityTasks", {})
    expect(queryResult).toHaveLength(2)
    expect(queryResult[0].title).toBe("Fix critical bug")

    const templateResult = await executeView(TEST_SCHEMA_NAME, "taskReport", {})
    expect(templateResult).toContain("# High Priority Tasks")
    expect(templateResult).toContain("Total: 2")
    expect(templateResult).toContain("Fix critical bug")

    // Store schema ID for later
    const schemaId = schema.id

    // =====================================================
    // PART 2: Fresh Session - Load Schema and Execute Views
    // =====================================================

    // Reset everything (simulating new process/session)
    resetMetaStore()
    clearRuntimeStores()

    // Load schema from disk (simulating schema.load)
    const { loadSchema } = await import("../../persistence")
    const { metadata, enhanced } = await loadSchema(TEST_SCHEMA_NAME)

    // Verify metadata includes views
    expect(metadata.views).toBeDefined()
    expect(metadata.views!.highPriorityTasks).toBeDefined()
    expect(metadata.views!.taskReport).toBeDefined()

    // Ingest into fresh meta-store
    const freshMetaStore = getMetaStore()
    const loadedSchema = freshMetaStore.ingestEnhancedJsonSchema(enhanced, metadata)

    // Verify schema ID matches
    expect(loadedSchema.id).toBe(schemaId)

    // Verify views were restored
    expect(loadedSchema.views).toHaveLength(2)
    const highPriorityView = loadedSchema.views.find((v: any) => v.name === "highPriorityTasks")
    expect(highPriorityView).toBeDefined()
    expect(highPriorityView.type).toBe("query")
    expect(highPriorityView.collection).toBe("Task")

    // Create runtime store for loaded schema
    const loadedRuntimeFactory = enhancedJsonSchemaToMST(enhanced)
    const loadedRuntimeStore = loadedRuntimeFactory.createStore()
    cacheRuntimeStore(loadedSchema.id, loadedRuntimeStore)

    // Re-populate data (in real usage, this would come from database/disk)
    loadedRuntimeStore.taskCollection.add({
      id: "task-1",
      title: "Fix critical bug",
      status: "pending",
      priority: "high"
    })
    loadedRuntimeStore.taskCollection.add({
      id: "task-2",
      title: "Write documentation",
      status: "completed",
      priority: "medium"
    })
    loadedRuntimeStore.taskCollection.add({
      id: "task-3",
      title: "Security audit",
      status: "pending",
      priority: "high"
    })

    // =====================================================
    // PART 3: Verify Views Work in Fresh Session
    // =====================================================

    // Execute query view in fresh session
    const freshQueryResult = await executeView(TEST_SCHEMA_NAME, "highPriorityTasks", {})
    expect(freshQueryResult).toHaveLength(2)
    expect(freshQueryResult[0].title).toBe("Fix critical bug")
    expect(freshQueryResult[1].title).toBe("Security audit")

    // Execute template view in fresh session
    const freshTemplateResult = await executeView(TEST_SCHEMA_NAME, "taskReport", {})
    expect(freshTemplateResult).toContain("# High Priority Tasks")
    expect(freshTemplateResult).toContain("Total: 2")
    expect(freshTemplateResult).toContain("Fix critical bug")
    expect(freshTemplateResult).toContain("Security audit")

    // Verify template file was read from disk
    const templateContent = await import("fs/promises").then(fs =>
      fs.readFile(`${TEST_SCHEMA_DIR}/templates/report.njk`, "utf-8")
    )
    expect(templateContent).toContain("# High Priority Tasks")
  })

  test("View management: view.define and view.delete", async () => {
    // Setup
    const { resetMetaStore, getMetaStore, clearRuntimeStores, cacheRuntimeStore } = await import("../bootstrap")
    const { saveSchema } = await import("../../persistence")
    const { scope } = await import("arktype")
    const { arkTypeToEnhancedJsonSchema } = await import("../../schematic/arktype-to-json-schema")
    const { enhancedJsonSchemaToMST } = await import("../../schematic/index")

    resetMetaStore()
    clearRuntimeStores()

    const TestSchema = scope({
      User: {
        id: "string",
        name: "string",
        role: "string"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(TestSchema, TEST_SCHEMA_NAME)
    const metaStore = getMetaStore()
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: TEST_SCHEMA_NAME
    })

    const runtimeFactory = enhancedJsonSchemaToMST(enhancedSchema)
    const runtimeStore = runtimeFactory.createStore()
    cacheRuntimeStore(schema.id, runtimeStore)

    // Initially no views
    expect(schema.views).toHaveLength(0)

    // Simulate view.define - add a view
    const { v4: uuidv4 } = await import("uuid")
    const viewDef1 = metaStore.viewDefinitionCollection.add({
      id: uuidv4(),
      schema: schema.id,
      name: "adminUsers",
      type: "query",
      collection: "User",
      filter: { role: "admin" }
    })

    expect(schema.views).toHaveLength(1)
    expect(schema.views[0].name).toBe("adminUsers")

    // Save schema
    await saveSchema(schema)

    // Simulate view.define - update existing view
    metaStore.viewDefinitionCollection.remove(viewDef1.id)
    const viewDef2 = metaStore.viewDefinitionCollection.add({
      id: uuidv4(),
      schema: schema.id,
      name: "adminUsers",
      type: "query",
      collection: "User",
      filter: { role: "administrator" }  // Updated filter
    })

    expect(schema.views).toHaveLength(1)
    expect(schema.views[0].filter).toEqual({ role: "administrator" })

    // Save updated schema
    await saveSchema(schema)

    // Simulate view.delete - remove the view
    metaStore.viewDefinitionCollection.remove(viewDef2.id)
    expect(schema.views).toHaveLength(0)

    // Save after deletion
    await saveSchema(schema)

    // Verify persistence: reset and load
    resetMetaStore()
    clearRuntimeStores()

    const { loadSchema } = await import("../../persistence")
    const { metadata, enhanced } = await loadSchema(TEST_SCHEMA_NAME)

    // Verify views field is empty (or undefined)
    expect(!metadata.views || Object.keys(metadata.views).length === 0).toBe(true)
  })
})
