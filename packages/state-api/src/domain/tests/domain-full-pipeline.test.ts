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
import { generateDDL, createSqliteDialect, tableDefToCreateTableSQL, deriveNamespace } from "../../ddl"
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
    const projectClientProp = schema.$defs!.Project.properties.clientId
    expect(projectClientProp["x-reference-target"]).toBe("Client")
    expect(projectClientProp["x-reference-type"]).toBe("single")

    // Task.projectId should have x-reference-target: "Project"
    const taskProjectProp = schema.$defs!.Task.properties.projectId
    expect(taskProjectProp["x-reference-target"]).toBe("Project")

    // Task.parentId (self-reference) should have x-reference-target: "Task"
    const taskParentProp = schema.$defs!.Task.properties.parentId
    expect(taskParentProp["x-reference-target"]).toBe("Task")

    // =================================================================
    // Step 4: Generate DDL and verify FK columns
    // =================================================================
    const namespace = deriveNamespace("project-tracker")
    const ddl = generateDDL(schema, sqliteDialect, { namespace })

    // Project table should have client_id FK column (namespace-prefixed)
    const projectTable = ddl.tables.find((t) => t.name === "project_tracker__project")
    expect(projectTable).toBeDefined()
    const clientColumn = projectTable!.columns.find((c) => c.name === "client_id")
    expect(clientColumn).toBeDefined()
    expect(clientColumn!.nullable).toBe(false) // required reference

    // Task table should have project_id and task_id (self-ref) FK columns
    const taskTable = ddl.tables.find((t) => t.name === "project_tracker__task")
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
    // Step 8: Query back all entities via abstraction layer
    // Verifies complete round-trip: INSERT → SQL → SELECT → normalized
    // =================================================================

    // Query Client
    const queriedClient = await store.clientCollection.query().where({ id: clientId }).first()
    expect(queriedClient).toBeDefined()
    expect(queriedClient.id).toBe(clientId)
    expect(queriedClient.name).toBe("Acme Corp")
    expect(queriedClient.industry).toBe("Technology")

    // Query Project - verify FK reference is correctly mapped
    const queriedProject = await store.projectCollection.query().where({ id: projectId }).first()
    expect(queriedProject).toBeDefined()
    expect(queriedProject.id).toBe(projectId)
    expect(queriedProject.name).toBe("Website Redesign")
    expect(queriedProject.clientId).toBe(clientId) // camelCase FK
    expect(queriedProject.status).toBe("active")
    expect((queriedProject as any).client_id).toBeUndefined() // NOT snake_case

    // Query Task - verify FK reference is correctly mapped
    const queriedTask = await store.taskCollection.query().where({ id: taskId }).first()
    expect(queriedTask).toBeDefined()
    expect(queriedTask.id).toBe(taskId)
    expect(queriedTask.title).toBe("Design homepage")
    expect(queriedTask.projectId).toBe(projectId) // camelCase FK
    expect(queriedTask.priority).toBe("high")
    expect(queriedTask.completed).toBe(false) // boolean type conversion
    expect(queriedTask.parentId).toBeUndefined() // no parent
    expect((queriedTask as any).project_id).toBeUndefined() // NOT snake_case

    // Query Subtask - verify self-reference FK is correctly mapped
    const queriedSubtask = await store.taskCollection.query().where({ id: subtaskId }).first()
    expect(queriedSubtask).toBeDefined()
    expect(queriedSubtask.id).toBe(subtaskId)
    expect(queriedSubtask.title).toBe("Create wireframe")
    expect(queriedSubtask.projectId).toBe(projectId)
    expect(queriedSubtask.parentId).toBe(taskId) // camelCase self-reference
    expect(queriedSubtask.completed).toBe(false)
    expect((queriedSubtask as any).task_id).toBeUndefined() // NOT snake_case

    // =================================================================
    // Step 9: Query by reference property (filter on FK)
    // =================================================================
    const projectTasks = await store.taskCollection.query().where({ projectId: projectId }).toArray()
    expect(projectTasks).toHaveLength(2)
    expect(projectTasks.map((t: any) => t.title).sort()).toEqual(["Create wireframe", "Design homepage"])

    // Query by self-reference FK
    const subtasks = await store.taskCollection.query().where({ parentId: taskId }).toArray()
    expect(subtasks).toHaveLength(1)
    expect(subtasks[0].title).toBe("Create wireframe")

    // =================================================================
    // Step 10: Query with multiple conditions and ordering
    // =================================================================
    const highPriorityTasks = await store.taskCollection
      .query()
      .where({ projectId: projectId, priority: "high" })
      .toArray()
    expect(highPriorityTasks).toHaveLength(1)
    expect(highPriorityTasks[0].title).toBe("Design homepage")

    // Count query
    const taskCount = await store.taskCollection.query().where({ projectId: projectId }).count()
    expect(taskCount).toBe(2)

    // Any query
    const hasIncompleteTasks = await store.taskCollection
      .query()
      .where({ projectId: projectId, completed: false })
      .any()
    expect(hasIncompleteTasks).toBe(true)
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
    const orderProps = orderDomain.enhancedSchema.$defs!.Order.properties
    expect(orderProps.customerId["x-reference-target"]).toBe("Customer")

    // Generate DDL with namespace
    const namespace = deriveNamespace("order-system")
    const ddl = generateDDL(orderDomain.enhancedSchema, sqliteDialect, { namespace })
    const orderTable = ddl.tables.find((t) => t.name === "order_system__order")
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

    // Insert a customer first
    const customerId = crypto.randomUUID()
    await store.customerCollection.insertOne({
      id: customerId,
      email: "alice@example.com",
    })

    // Insert order WITH customer reference
    const orderWithCustomerId = crypto.randomUUID()
    await store.orderCollection.insertOne({
      id: orderWithCustomerId,
      total: 149.99,
      customerId: customerId,
    })

    // Insert order WITHOUT customer (null reference)
    const orderWithoutCustomerId = crypto.randomUUID()
    await store.orderCollection.insertOne({
      id: orderWithoutCustomerId,
      total: 99.99,
      // customerId omitted (optional)
    })

    // Query order WITH customer - verify FK is correctly mapped
    const orderWithCustomer = await store.orderCollection.query().where({ id: orderWithCustomerId }).first()
    expect(orderWithCustomer).toBeDefined()
    expect(orderWithCustomer.id).toBe(orderWithCustomerId)
    expect(orderWithCustomer.total).toBe(149.99)
    expect(orderWithCustomer.customerId).toBe(customerId) // camelCase FK
    expect((orderWithCustomer as any).customer_id).toBeUndefined() // NOT snake_case

    // Query order WITHOUT customer - verify null reference returns undefined
    const orderWithoutCustomer = await store.orderCollection.query().where({ id: orderWithoutCustomerId }).first()
    expect(orderWithoutCustomer).toBeDefined()
    expect(orderWithoutCustomer.id).toBe(orderWithoutCustomerId)
    expect(orderWithoutCustomer.total).toBe(99.99)
    expect(orderWithoutCustomer.customerId).toBeUndefined() // null → undefined

    // Query by FK - find orders for a specific customer
    const customerOrders = await store.orderCollection.query().where({ customerId: customerId }).toArray()
    expect(customerOrders).toHaveLength(1)
    expect(customerOrders[0].id).toBe(orderWithCustomerId)

    // Count orders
    const totalOrders = await store.orderCollection.query().count()
    expect(totalOrders).toBe(2)
  })
})
