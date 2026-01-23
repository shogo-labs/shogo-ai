/**
 * Domain MCP E2E Integration Test
 *
 * End-to-end test validating the browser-to-MCP-to-Postgres flow.
 * Tests the complete data path:
 *
 * Browser: teamsDomain.createStore(env with MCPBackend)
 *   → collection.query().where({...}).toArray()
 *   → MCPQueryExecutor.select(ast)
 *   → mcpService.callTool('store.query', { ast, ... })
 *   → HTTP → MCP Server → SqlQueryExecutor → PostgreSQL
 *
 * Prerequisites:
 * - MCP server running at localhost:3100 (bun run dev --filter=@shogo/mcp)
 * - DATABASE_URL environment variable set (for MCP server)
 * - teams-workspace schema loaded and tables created
 *
 * Run with: bun test apps/web/src/__tests__/domain-mcp-e2e.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { MCPService, MCPBackend } from "@shogo/app-core"
import { teamsDomain, createBackendRegistry, NullPersistence } from "@shogo/state-api"

// Check if MCP server is available
async function isMCPServerAvailable(): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:3100/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" }
        }
      })
    })
    return response.ok
  } catch {
    return false
  }
}

// Skip all tests if MCP server not available
const describeMCPE2E = describe

describeMCPE2E("Domain MCP E2E Integration", () => {
  let mcpService: MCPService
  let mcpBackend: MCPBackend
  let store: ReturnType<typeof teamsDomain.createStore>
  let mcpAvailable = false

  // Test data IDs - generated fresh for each test run
  const testIds = {
    org: crypto.randomUUID(),
    team: crypto.randomUUID(),
    membership: crypto.randomUUID(),
  }

  beforeAll(async () => {
    mcpAvailable = await isMCPServerAvailable()
    if (!mcpAvailable) {
      console.log("⚠️  MCP server not available at localhost:3100 - skipping E2E tests")
      return
    }

    // Initialize MCP service
    mcpService = new MCPService()
    await mcpService.initializeSession()

    // Create MCP-backed registry
    mcpBackend = new MCPBackend(mcpService, "test-workspace")
    const registry = createBackendRegistry({
      default: "postgres",
      backends: { postgres: mcpBackend }
    })

    // Create store with MCP backend
    store = teamsDomain.createStore({
      services: {
        persistence: new NullPersistence(),
        backendRegistry: registry,
      },
      context: {
        schemaName: "teams-workspace",
      },
    })

    // Ensure schema is loaded in MCP server
    try {
      await mcpService.callTool("schema.load", {
        name: "teams-workspace",
        workspace: "test-workspace"
      })
    } catch (e) {
      // Schema might already be loaded
      console.log("Schema load info:", e)
    }
  })

  afterAll(async () => {
    if (!mcpAvailable) return

    // Clean up test data via MCP
    try {
      await mcpService.callTool("store.delete", {
        schema: "teams-workspace",
        model: "Membership",
        id: testIds.membership,
        workspace: "test-workspace"
      })
    } catch { /* ignore cleanup errors */ }

    try {
      await mcpService.callTool("store.delete", {
        schema: "teams-workspace",
        model: "Team",
        id: testIds.team,
        workspace: "test-workspace"
      })
    } catch { /* ignore cleanup errors */ }

    try {
      await mcpService.callTool("store.delete", {
        schema: "teams-workspace",
        model: "Organization",
        id: testIds.org,
        workspace: "test-workspace"
      })
    } catch { /* ignore cleanup errors */ }

    mcpService.clearSession()
  })

  // ===========================================================================
  // CRUD Operations via MCP
  // ===========================================================================

  test("insertOne creates entity in postgres via MCP", async () => {
    if (!mcpAvailable) {
      console.log("⏭️  Skipping: MCP server not available")
      return
    }

    // Given: Organization data
    const orgData = {
      id: testIds.org,
      name: "Test Org via MCP",
      slug: "test-org-mcp",
    }

    // When: Insert via domain store (uses MCPBackend → MCP server → Postgres)
    const created = await store.organizationCollection.insertOne(orgData)

    // Then: Entity is created with correct data
    expect(created).toBeDefined()
    expect(created.id).toBe(testIds.org)
    expect(created.name).toBe("Test Org via MCP")
    expect(created.slug).toBe("test-org-mcp")
  })

  test("query().where().toArray() retrieves from postgres", async () => {
    if (!mcpAvailable) {
      console.log("⏭️  Skipping: MCP server not available")
      return
    }

    // When: Query via domain store
    const results = await store.organizationCollection
      .query<any>()
      .where({ id: testIds.org })
      .toArray()

    // Then: Results contain our test entity
    expect(results.length).toBeGreaterThanOrEqual(1)
    const found = results.find((r: any) => r.id === testIds.org)
    expect(found).toBeDefined()
    expect(found.name).toBe("Test Org via MCP")
  })

  test("query().first() retrieves single entity", async () => {
    if (!mcpAvailable) {
      console.log("⏭️  Skipping: MCP server not available")
      return
    }

    // When: Query first entity matching condition
    const result = await store.organizationCollection
      .query<any>()
      .where({ id: testIds.org })
      .first()

    // Then: Returns single entity
    expect(result).toBeDefined()
    expect(result?.id).toBe(testIds.org)
    expect(result?.name).toBe("Test Org via MCP")
  })

  test("updateOne modifies entity in postgres", async () => {
    if (!mcpAvailable) {
      console.log("⏭️  Skipping: MCP server not available")
      return
    }

    // When: Update via domain store
    const updated = await store.organizationCollection.updateOne(
      testIds.org,
      { name: "Updated Org Name" }
    )

    // Then: Entity is updated
    expect(updated).toBeDefined()
    expect(updated?.name).toBe("Updated Org Name")

    // Verify via query
    const verified = await store.organizationCollection
      .query<any>()
      .where({ id: testIds.org })
      .first()
    expect(verified?.name).toBe("Updated Org Name")
  })

  test("query().count() returns correct count", async () => {
    if (!mcpAvailable) {
      console.log("⏭️  Skipping: MCP server not available")
      return
    }

    // When: Count entities matching condition
    const count = await store.organizationCollection
      .query<any>()
      .where({ id: testIds.org })
      .count()

    // Then: Count is correct
    expect(count).toBe(1)
  })

  test("query().any() returns true when entity exists", async () => {
    if (!mcpAvailable) {
      console.log("⏭️  Skipping: MCP server not available")
      return
    }

    // When: Check existence
    const exists = await store.organizationCollection
      .query<any>()
      .where({ id: testIds.org })
      .any()

    // Then: Returns true
    expect(exists).toBe(true)

    // Non-existent ID returns false
    const notExists = await store.organizationCollection
      .query<any>()
      .where({ id: "non-existent-id" })
      .any()
    expect(notExists).toBe(false)
  })

  test("MST store syncs after remote operations", async () => {
    if (!mcpAvailable) {
      console.log("⏭️  Skipping: MCP server not available")
      return
    }

    // Given: Execute a query to fetch data
    await store.organizationCollection
      .query<any>()
      .where({ id: testIds.org })
      .toArray()

    // Then: MST store should have the entity synced
    // (The MCPQueryExecutor uses executorType: 'remote' which triggers syncFromRemote)
    const mstEntity = store.organizationCollection.items.get(testIds.org)
    expect(mstEntity).toBeDefined()
    expect(mstEntity?.name).toBe("Updated Org Name")
  })

  test("deleteOne removes entity from postgres", async () => {
    if (!mcpAvailable) {
      console.log("⏭️  Skipping: MCP server not available")
      return
    }

    // First create an org to delete
    const deleteTestId = crypto.randomUUID()
    await store.organizationCollection.insertOne({
      id: deleteTestId,
      name: "To Be Deleted",
      slug: "to-delete"
    })

    // Verify it exists
    const existsBefore = await store.organizationCollection
      .query<any>()
      .where({ id: deleteTestId })
      .any()
    expect(existsBefore).toBe(true)

    // When: Delete via domain store
    const deleted = await store.organizationCollection.deleteOne(deleteTestId)

    // Then: Returns true and entity is gone
    expect(deleted).toBe(true)

    const existsAfter = await store.organizationCollection
      .query<any>()
      .where({ id: deleteTestId })
      .any()
    expect(existsAfter).toBe(false)
  })

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  test("insertMany creates batch atomically", async () => {
    if (!mcpAvailable) {
      console.log("⏭️  Skipping: MCP server not available")
      return
    }

    // Given: Multiple teams to insert
    const batchIds = [crypto.randomUUID(), crypto.randomUUID()]
    const teams = batchIds.map((id, i) => ({
      id,
      name: `Batch Team ${i + 1}`,
      slug: `batch-team-${i + 1}`,
      organizationId: testIds.org
    }))

    // When: Insert batch
    const created = await store.teamCollection.insertMany(teams)

    // Then: All teams created
    expect(created).toHaveLength(2)
    expect(created[0].name).toBe("Batch Team 1")
    expect(created[1].name).toBe("Batch Team 2")

    // Cleanup
    for (const id of batchIds) {
      await store.teamCollection.deleteOne(id)
    }
  })
})
