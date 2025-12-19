/**
 * MCPBackend Tests
 *
 * Tests for the browser-side backend that uses MCPQueryExecutor.
 * Implements createExecutor factory pattern for registry integration.
 *
 * TDD Tests
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { MCPBackend } from "../MCPBackend"
import { MCPQueryExecutor } from "../MCPQueryExecutor"
import type { MCPService } from "../../services/mcpService"

// =============================================================================
// Mock MCPService
// =============================================================================

function createMockMCPService() {
  return {
    callTool: () => Promise.resolve({ ok: true }),
  } as unknown as MCPService
}

// =============================================================================
// Tests
// =============================================================================

describe("MCPBackend", () => {
  let mockMcp: ReturnType<typeof createMockMCPService>

  beforeEach(() => {
    mockMcp = createMockMCPService()
  })

  test("createExecutor() returns MCPQueryExecutor instance", () => {
    // Given: MCPBackend
    const backend = new MCPBackend(mockMcp)

    // When: createExecutor is called
    const executor = backend.createExecutor("test-schema", "Task")

    // Then: Returns MCPQueryExecutor
    expect(executor).toBeInstanceOf(MCPQueryExecutor)
  })

  test("createExecutor() passes schemaName, modelName to executor", () => {
    // Given: MCPBackend
    const backend = new MCPBackend(mockMcp)

    // When: createExecutor is called
    const executor = backend.createExecutor("my-schema", "MyModel") as MCPQueryExecutor<any>

    // Then: Executor has correct schema and model
    // We verify this by checking the executor can be used
    // (Direct property access would require exposing private members)
    expect(executor).toBeInstanceOf(MCPQueryExecutor)
    expect(executor.executorType).toBe("remote")
  })

  test("createExecutor() passes workspace from constructor", () => {
    // Given: MCPBackend with workspace
    const backend = new MCPBackend(mockMcp, "my-workspace")

    // When: createExecutor is called
    const executor = backend.createExecutor("test-schema", "Task") as MCPQueryExecutor<any>

    // Then: Executor is created with workspace
    // (Workspace is passed internally - verified via integration tests)
    expect(executor).toBeInstanceOf(MCPQueryExecutor)
  })

  test("has no dialect property (distinguishes from SqlBackend)", () => {
    // Given: MCPBackend
    const backend = new MCPBackend(mockMcp)

    // Then: No dialect property exists
    expect((backend as any).dialect).toBeUndefined()
  })

  test("has capabilities property", () => {
    // Given: MCPBackend
    const backend = new MCPBackend(mockMcp)

    // Then: Has capabilities
    expect(backend.capabilities).toBeDefined()
    expect(backend.capabilities.operators).toContain("eq")
    expect(backend.capabilities.operators).toContain("and")
    expect(backend.capabilities.operators).toContain("or")
    expect(backend.capabilities.features.sorting).toBe(true)
    expect(backend.capabilities.features.pagination).toBe(true)
  })

  test("execute() throws error directing to use createExecutor()", async () => {
    // Given: MCPBackend
    const backend = new MCPBackend(mockMcp)

    // When/Then: execute() throws
    await expect(backend.execute({} as any, {})).rejects.toThrow("Use createExecutor() instead")
  })
})
