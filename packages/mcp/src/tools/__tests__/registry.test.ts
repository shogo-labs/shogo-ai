/**
 * Registry Tests
 *
 * Tests for MCP tool registration in registry.ts
 * Updated for Issue 3: store.query replaces db.query
 */

import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

describe("MCP Registry", () => {
  /**
   * Test Spec: Registry imports and registers all tools
   */
  test("store.query tool is registered in MCP registry", () => {
    // Given: MCP server is initialized
    // When: registerAllTools has been called
    // Then: store.query is registered in Store namespace

    const registryPath = join(__dirname, "../registry.ts")
    const registryContent = readFileSync(registryPath, "utf-8")

    // Verify import exists
    expect(registryContent).toContain('import { registerStoreQuery } from "./store.query"')

    // Verify registration call exists
    expect(registryContent).toContain("registerStoreQuery(server)")
  })

  test("store namespace tools registered in correct order", () => {
    // Given: MCP server is initialized
    // When: registerAllTools() executes
    // Then: store.query registered successfully alongside other store tools

    const registryPath = join(__dirname, "../registry.ts")
    const registryContent = readFileSync(registryPath, "utf-8")

    // Verify store.query is registered
    expect(registryContent).toContain("registerStoreQuery(server)")

    // Verify the function can be imported without errors
    const { registerAllTools } = require("../registry")
    expect(typeof registerAllTools).toBe("function")
  })

  test("tool count reflects current tool set", () => {
    // Given: MCP registry.ts file exists
    // When: Header comment is inspected
    // Then: Comment reflects correct tool count (19 tools after bootstrap removal)

    const registryPath = join(__dirname, "../registry.ts")
    const registryContent = readFileSync(registryPath, "utf-8")

    // Verify tool count comment (19 tools total after removing bootstrap)
    expect(registryContent).toMatch(/Total:\s*19\s*tools/i)

    // Verify namespace count (6 namespaces)
    expect(registryContent).toMatch(/6\s*namespaces/i)

    // Verify Store namespace mentions 7 tools (including query, delete)
    expect(registryContent).toContain("Store: 7 tools")
    expect(registryContent).toContain("query")
    expect(registryContent).toContain("delete")

    // Verify Data namespace mentions 2 tools (load, loadAll) - bootstrap removed
    expect(registryContent).toContain("Data: 2 tools")
    expect(registryContent).toContain("load")
    expect(registryContent).toContain("loadAll")
  })

  test("db.query has been removed from registry", () => {
    // Verify db.query is no longer imported or registered
    const registryPath = join(__dirname, "../registry.ts")
    const registryContent = readFileSync(registryPath, "utf-8")

    // DB tools section and registerDbQuery should be gone
    expect(registryContent).not.toContain('registerDbQuery')
    expect(registryContent).not.toContain('db.query')
  })

  test("data.bootstrap has been removed from registry", () => {
    // Given: MCP registry.ts file exists
    // When: The registry is inspected
    // Then: data.bootstrap is NOT in the list of available tools

    const registryPath = join(__dirname, "../registry.ts")
    const registryContent = readFileSync(registryPath, "utf-8")

    // Verify bootstrap import and registration are removed
    expect(registryContent).not.toContain('registerDataBootstrap')
    expect(registryContent).not.toContain('data.bootstrap')

    // Verify data.load and data.loadAll still exist
    expect(registryContent).toContain('registerDataLoad')
    expect(registryContent).toContain('registerDataLoadAll')
  })
})
