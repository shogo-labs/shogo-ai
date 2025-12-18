/**
 * domain() Full Pipeline Integration Test
 *
 * End-to-end test of complete code-first workflow:
 * ArkType Scope -> domain() -> Enhanced JSON Schema -> DDL -> SQL CRUD
 *
 * This validates that a developer can:
 * 1. Define entities with references using ArkType
 * 2. Create a domain() from the scope
 * 3. Generate DDL with correct FK columns
 * 4. Use the store with SQL persistence
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { scope } from "arktype"
import { domain } from "../domain"
import { generateDDL, createSqliteDialect, tableDefToCreateTableSQL } from "../../ddl"
import { BunSqlExecutor } from "../../query/execution/bun-sql"
import { createBackendRegistry } from "../../query/registry"
import { SqlBackend } from "../../query/backends/sql"
import { NullPersistence } from "../../persistence/null"

const sqliteDialect = createSqliteDialect()

describe("domain() Full Pipeline: ArkType -> SQL Persistence", () => {
  let db: Database

  beforeEach(() => {
    db = new Database(":memory:")
  })

  afterEach(() => {
    db.close()
  })

  test("complete workflow: define -> generate DDL -> insert -> query", async () => {
    // =================================================================
    // Step 1: Define ArkType scope with entity references
    // =================================================================
    const ProjectScope = scope({
      Client: {
        id: "string.uuid",
        name: "string",
        industry: "string",
      },
      Project: {
        id: "string.uuid",
        name: "string",
        "description?": "string",
        clientId: "Client", // Reference to Client
        status: "'draft' | 'active' | 'completed'",
        createdAt: "number",
      },
      Task: {
        id: "string.uuid",
        title: "string",
        projectId: "Project", // Reference to Project
        "parentId?": "Task", // Self-reference for subtasks
        priority: "'low' | 'medium' | 'high'",
        completed: "boolean",
      },
    })

    // =================================================================
    // Step 2: Create domain from scope
    // =================================================================
    const projectDomain = domain({
      name: "project-tracker",
      from: ProjectScope,
    })

    // =================================================================
    // Step 3: Verify x-reference-target in Enhanced JSON Schema
    // =================================================================
    const schema = projectDomain.enhancedSchema

    // Project.clientId should have x-reference-target: "Client"
    const projectClientProp = schema.$defs.Project.properties.clientId
    expect(projectClientProp["x-reference-target"]).toBe("Client")
    expect(projectClientProp["x-reference-type"]).toBe("single")

    // Task.projectId should have x-reference-target: "Project"
    const taskProjectProp = schema.$defs.Task.properties.projectId
    expect(taskProjectProp["x-reference-target"]).toBe("Project")

    // Task.parentId (self-reference) should have x-reference-target: "Task"
    const taskParentProp = schema.$defs.Task.properties.parentId
    expect(taskParentProp["x-reference-target"]).toBe("Task")

    // =================================================================
    // Step 4: Generate DDL and verify FK columns
    // =================================================================
    const ddl = generateDDL(schema, sqliteDialect)

    // Project table should have client_id FK column
    const projectTable = ddl.tables.find((t) => t.name === "project")
    expect(projectTable).toBeDefined()
    const clientColumn = projectTable!.columns.find((c) => c.name === "client_id")
    expect(clientColumn).toBeDefined()
    expect(clientColumn!.nullable).toBe(false) // required reference

    // Task table should have project_id and task_id (self-ref) FK columns
    const taskTable = ddl.tables.find((t) => t.name === "task")
    expect(taskTable).toBeDefined()
    const projectColumn = taskTable!.columns.find((c) => c.name === "project_id")
    expect(projectColumn).toBeDefined()
    const parentColumn = taskTable!.columns.find((c) => c.name === "task_id")
    expect(parentColumn).toBeDefined()
    expect(parentColumn!.nullable).toBe(true) // optional self-reference

    // =================================================================
    // Step 5: Create SQL tables from DDL
    // =================================================================
    for (const tableName of ddl.executionOrder) {
      const table = ddl.tables.find((t) => t.name === tableName)
      if (table) {
        db.run(tableDefToCreateTableSQL(table, sqliteDialect))
      }
    }

    // =================================================================
    // Step 6: Create SQL-backed store (NO meta-store registration needed)
    // Column mapping comes from pre-computed maps in domain()
    // =================================================================
    const registry = createBackendRegistry()
    const executor = new BunSqlExecutor(db)
    const sqlBackend = new SqlBackend({ dialect: "sqlite", executor })
    registry.register("sql", sqlBackend)
    registry.setDefault("sql")

    const store = projectDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        backendRegistry: registry,
      },
      context: {
        schemaName: "project-tracker",
      },
    })

    // =================================================================
    // Step 7: INSERT entities with references (camelCase properties)
    // =================================================================
    const clientId = crypto.randomUUID()
    const projectId = crypto.randomUUID()
    const taskId = crypto.randomUUID()
    const subtaskId = crypto.randomUUID()

    await store.clientCollection.insertOne({
      id: clientId,
      name: "Acme Corp",
      industry: "Technology",
    })

    await store.projectCollection.insertOne({
      id: projectId,
      name: "Website Redesign",
      clientId: clientId, // camelCase property
      status: "active",
      createdAt: Date.now(),
    })

    await store.taskCollection.insertOne({
      id: taskId,
      title: "Design homepage",
      projectId: projectId, // camelCase property
      priority: "high",
      completed: false,
    })

    await store.taskCollection.insertOne({
      id: subtaskId,
      title: "Create wireframe",
      projectId: projectId,
      parentId: taskId, // self-reference (camelCase)
      priority: "medium",
      completed: false,
    })

    // =================================================================
    // Step 8: Verify SQL tables have snake_case FK columns
    // =================================================================
    const projectRow = db.prepare("SELECT client_id FROM project WHERE id = ?").get(projectId) as any
    expect(projectRow.client_id).toBe(clientId)

    const taskRow = db.prepare("SELECT project_id FROM task WHERE id = ?").get(taskId) as any
    expect(taskRow.project_id).toBe(projectId)

    const subtaskRow = db.prepare("SELECT task_id FROM task WHERE id = ?").get(subtaskId) as any
    expect(subtaskRow.task_id).toBe(taskId)

    // =================================================================
    // Step 9: SELECT entities - verify camelCase normalization
    // =================================================================
    const queriedProject = await store.projectCollection.query().where({ id: projectId }).first()
    expect(queriedProject.clientId).toBe(clientId) // camelCase
    expect((queriedProject as any).client_id).toBeUndefined() // NOT snake_case

    const queriedSubtask = await store.taskCollection.query().where({ id: subtaskId }).first()
    expect(queriedSubtask.projectId).toBe(projectId)
    expect(queriedSubtask.parentId).toBe(taskId) // camelCase self-reference
    expect((queriedSubtask as any).task_id).toBeUndefined()

    // =================================================================
    // Step 10: Query by reference property (camelCase filter)
    // =================================================================
    const projectTasks = await store.taskCollection.query().where({ projectId: projectId }).toArray()
    expect(projectTasks).toHaveLength(2)
    expect(projectTasks.map((t: any) => t.title).sort()).toEqual(["Create wireframe", "Design homepage"])
  })

  test("optional references work correctly in full pipeline", async () => {
    // Define scope with optional reference
    const OrderScope = scope({
      Customer: {
        id: "string.uuid",
        email: "string",
      },
      Order: {
        id: "string.uuid",
        total: "number",
        "customerId?": "Customer", // Optional reference
      },
    })

    const orderDomain = domain({
      name: "order-system",
      from: OrderScope,
    })

    // Verify x-reference-target
    const orderProps = orderDomain.enhancedSchema.$defs.Order.properties
    expect(orderProps.customerId["x-reference-target"]).toBe("Customer")

    // Generate DDL
    const ddl = generateDDL(orderDomain.enhancedSchema, sqliteDialect)
    const orderTable = ddl.tables.find((t) => t.name === "order")
    const customerColumn = orderTable!.columns.find((c) => c.name === "customer_id")
    expect(customerColumn!.nullable).toBe(true) // optional = nullable

    // Create tables
    for (const tableName of ddl.executionOrder) {
      const table = ddl.tables.find((t) => t.name === tableName)
      if (table) {
        db.run(tableDefToCreateTableSQL(table, sqliteDialect))
      }
    }

    // Create store (NO meta-store registration needed - column mapping is pre-computed)
    const registry = createBackendRegistry()
    const executor = new BunSqlExecutor(db)
    registry.register("sql", new SqlBackend({ dialect: "sqlite", executor }))
    registry.setDefault("sql")

    const store = orderDomain.createStore({
      services: { persistence: new NullPersistence(), backendRegistry: registry },
      context: { schemaName: "order-system" },
    })

    // Insert order WITHOUT customer (null reference)
    const orderId = crypto.randomUUID()
    await store.orderCollection.insertOne({
      id: orderId,
      total: 99.99,
      // customerId omitted (optional)
    })

    // Verify NULL in database
    const row = db.prepare("SELECT customer_id FROM \"order\" WHERE id = ?").get(orderId) as any
    expect(row.customer_id).toBeNull()

    // Query returns undefined for null reference
    const order = await store.orderCollection.query().where({ id: orderId }).first()
    expect(order.customerId).toBeUndefined()
  })
})
