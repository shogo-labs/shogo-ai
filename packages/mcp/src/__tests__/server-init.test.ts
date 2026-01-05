/**
 * Server Initialization Tests
 *
 * Tests for MCP server startup sequence including seed data initialization.
 *
 * Generated from TestSpecifications:
 * - test-1-3-006: Server startup calls initializeSeedData after DDL initialization
 * - test-1-3-007: Server startup passes correct schemasPath to initializeSeedData
 */

import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

describe("Server Initialization", () => {
  const serverPath = join(__dirname, "../server.ts")

  test("imports initializeSeedData from seed-init", () => {
    // Given: server.ts exists
    const serverContent = readFileSync(serverPath, "utf-8")

    // Then: initializeSeedData is imported from './seed-init'
    expect(serverContent).toContain('import { initializeSeedData } from "./seed-init"')
  })

  test("calls initializeSeedData after initializeDomainSchemas", () => {
    // Given: server.ts exists
    const serverContent = readFileSync(serverPath, "utf-8")

    // Then: initializeSeedData is called
    expect(serverContent).toContain("initializeSeedData")

    // And: The call appears after initializeDomainSchemas
    const ddlIndex = serverContent.indexOf("initializeDomainSchemas")
    const seedIndex = serverContent.indexOf("initializeSeedData(")
    const fastMcpIndex = serverContent.indexOf("new FastMCP")

    expect(ddlIndex).toBeGreaterThan(-1)
    expect(seedIndex).toBeGreaterThan(-1)
    expect(fastMcpIndex).toBeGreaterThan(-1)

    // Seed init should come after DDL init
    expect(seedIndex).toBeGreaterThan(ddlIndex)

    // Seed init should come before FastMCP server creation
    expect(seedIndex).toBeLessThan(fastMcpIndex)
  })

  test("awaits initializeSeedData call", () => {
    // Given: server.ts exists
    const serverContent = readFileSync(serverPath, "utf-8")

    // Then: The call is awaited (blocking initialization)
    expect(serverContent).toMatch(/await\s+initializeSeedData/)
  })

  test("passes schemasPath to initializeSeedData", () => {
    // Given: server.ts exists
    const serverContent = readFileSync(serverPath, "utf-8")

    // Then: schemasPath is passed (same path as DDL init)
    // The path pattern should be: join(import.meta.dir, "../../../.schemas")
    expect(serverContent).toMatch(/initializeSeedData\([^)]*\.schemas/)
  })

  test("startup sequence is in correct order", () => {
    // Given: server.ts exists
    const serverContent = readFileSync(serverPath, "utf-8")

    // Extract the positions of key initialization steps (calls, not imports)
    const postgresInit = serverContent.indexOf("await initializePostgresBackend()")
    const ddlInit = serverContent.indexOf("await initializeDomainSchemas(")
    const seedInit = serverContent.indexOf("await initializeSeedData(")
    const fastMcp = serverContent.indexOf("new FastMCP")
    const registerTools = serverContent.indexOf("registerAllTools(server)")

    // Verify correct order:
    // 1. Postgres backend
    // 2. DDL init (tables)
    // 3. Seed init (data)
    // 4. FastMCP server
    // 5. Register tools

    expect(postgresInit).toBeGreaterThan(-1)
    expect(ddlInit).toBeGreaterThan(postgresInit)
    expect(seedInit).toBeGreaterThan(ddlInit)
    expect(fastMcp).toBeGreaterThan(seedInit)
    expect(registerTools).toBeGreaterThan(fastMcp)
  })
})
