/**
 * Query Test Utilities
 *
 * Helper functions for setting up test environments with different backends.
 * Used by integration tests to create memory and SQL stores with seeded data.
 */

import { Database } from "bun:sqlite"
import { BunSqlExecutor } from "../../src/query/execution/bun-sql"
import { createBackendRegistry } from "../../src/query/registry"
import { NullPersistence } from "../../src/persistence/null"
import { teamsDomain } from "../../src/teams/domain"
// import { generateDDL } from "../../src/ddl"

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
    // TODO: Register SQL backend once SqlQueryExecutor is implemented
    throw new Error("SQL backend not yet implemented")
  } else {
    // TODO: Register memory backend once MemoryQueryExecutor is implemented
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
    // TODO: Generate and run DDL once DDL generator is implemented
    // const ddl = generateDDL(teamsDomain.enhancedSchema, { dialect: "sqlite" })
    // for (const stmt of ddl) {
    //   db.run(stmt)
    // }
    env = createEnvironment({
      backend: "sql",
      sqlExecutor: new BunSqlExecutor(db)
    })
  } else {
    env = createEnvironment({ backend: "memory" })
  }

  const store = teamsDomain.createStore(env)

  // Seed data
  for (const org of data.organizations) {
    await store.organizationCollection.add(org)
  }
  for (const team of data.teams) {
    await store.teamCollection.add(team)
  }
  for (const mem of data.memberships) {
    await store.membershipCollection.add(mem)
  }

  return store
}
