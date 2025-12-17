/**
 * Query Test Utilities
 *
 * Helper functions for setting up test environments with different backends.
 * Used by integration tests to create memory and SQL stores with seeded data.
 */

import { Database } from "bun:sqlite"
import { BunSqlExecutor } from "../../src/query/execution/bun-sql"
import { createBackendRegistry } from "../../src/query/registry"
import { MemoryBackend } from "../../src/query/backends/memory"
import { SqlBackend } from "../../src/query/backends/sql"
import { NullPersistence } from "../../src/persistence/null"
import { teamsDomain } from "../../src/teams/domain"
import { generateDDL, createSqliteDialect, tableDefToCreateTableSQL } from "../../src/ddl"

export interface TestData {
  organizations: Array<{
    id: string
    name: string
    slug: string
    createdAt: number
  }>
  teams: Array<{
    id: string
    name: string
    organizationId: string
    createdAt: number
  }>
  memberships: Array<{
    id: string
    userId: string
    role: string
    teamId: string
    createdAt: number
  }>
}

export interface CreateEnvironmentOptions {
  backend: "memory" | "sql"
  sqlExecutor?: BunSqlExecutor
}

/**
 * Create environment with configured backend registry.
 *
 * For memory backend: Uses default MemoryBackend
 * For SQL backend: Requires sqlExecutor parameter
 */
export function createEnvironment(options: CreateEnvironmentOptions) {
  const registry = createBackendRegistry()

  if (options.backend === "sql") {
    if (!options.sqlExecutor) {
      throw new Error("SQL backend requires sqlExecutor")
    }

    // Register SQL backend with executor
    const sqlBackend = new SqlBackend({
      dialect: "sqlite",
      executor: options.sqlExecutor
    })

    registry.register("sql", sqlBackend)
    registry.setDefault("sql")
  } else {
    // Register memory backend
    const memoryBackend = new MemoryBackend()

    registry.register("memory", memoryBackend)
    registry.setDefault("memory")
  }

  return {
    services: {
      persistence: new NullPersistence(),
      backendRegistry: registry
    },
    context: {
      schemaName: "teams-workspace"
    }
  }
}

// Cache dialect instance
const sqliteDialect = createSqliteDialect()

/**
 * Create tables from Enhanced JSON Schema using DDL generator.
 *
 * @param db - SQLite database instance
 * @param schema - Enhanced JSON Schema to generate DDL from
 */
function createTablesFromSchema(db: Database, schema: any) {
  const ddl = generateDDL(schema, sqliteDialect)

  // Create tables in topological order (respects FK dependencies)
  for (const tableName of ddl.executionOrder) {
    const table = ddl.tables.find(t => t.name === tableName)
    if (table) {
      const sql = tableDefToCreateTableSQL(table, sqliteDialect)
      db.run(sql)
    }
  }
}

/**
 * Create a store with seeded test data.
 *
 * @param backend - "memory" or "sql"
 * @param data - Test data to seed
 * @returns Store instance with seeded data
 */
export async function createSeededStore(
  backend: "memory" | "sql",
  data: TestData
) {
  let env: any
  let db: Database | undefined

  if (backend === "sql") {
    db = new Database(":memory:")

    // Create tables using DDL generator (schema has proper x-mst-type metadata)
    createTablesFromSchema(db, teamsDomain.enhancedSchema)

    env = createEnvironment({
      backend: "sql",
      sqlExecutor: new BunSqlExecutor(db)
    })
  } else {
    env = createEnvironment({ backend: "memory" })
  }

  const store = teamsDomain.createStore(env)

  // Seed data using CollectionMutatable.insertOne for isomorphic behavior
  // Note: insertOne preserves explicit IDs when provided
  for (const org of data.organizations) {
    await store.organizationCollection.insertOne(org)
  }
  for (const team of data.teams) {
    await store.teamCollection.insertOne(team)
  }
  for (const mem of data.memberships) {
    await store.membershipCollection.insertOne(mem)
  }

  return store
}
