/**
 * RED Tests for MCPPersistence Lazy Init
 *
 * Phase 3 of the Elegant Domain Provider Architecture plan.
 * These tests verify lazy initialization and retry behavior.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { MCPPersistence } from "../MCPPersistence"

// Mock MCP service
function createMockMCPService() {
  return {
    initializeSession: mock(async () => {}),
    callTool: mock(async () => ({ ok: true, items: [] })),
  }
}

describe("MCPPersistence Lazy Init", () => {
  test("calls initializeSession on first loadCollection", async () => {
    const mockMcp = createMockMCPService()
    const persistence = new MCPPersistence(mockMcp as any)

    await persistence.loadCollection({
      schemaName: "test",
      modelName: "TestModel",
    })

    expect(mockMcp.initializeSession).toHaveBeenCalledTimes(1)
  })

  test("calls initializeSession only once for multiple operations", async () => {
    const mockMcp = createMockMCPService()
    const persistence = new MCPPersistence(mockMcp as any)

    // Multiple operations
    await persistence.loadCollection({ schemaName: "test", modelName: "A" })
    await persistence.loadCollection({ schemaName: "test", modelName: "B" })
    await persistence.loadEntity({ schemaName: "test", modelName: "C", entityId: "1" })

    // Should only initialize once
    expect(mockMcp.initializeSession).toHaveBeenCalledTimes(1)
  })

  test("concurrent operations share same init promise", async () => {
    let initCallCount = 0
    const mockMcp = {
      initializeSession: mock(async () => {
        initCallCount++
        // Simulate network delay
        await new Promise((r) => setTimeout(r, 50))
      }),
      callTool: mock(async () => ({ ok: true, items: [] })),
    }

    const persistence = new MCPPersistence(mockMcp as any)

    // Fire concurrent operations
    await Promise.all([
      persistence.loadCollection({ schemaName: "test", modelName: "A" }),
      persistence.loadCollection({ schemaName: "test", modelName: "B" }),
      persistence.loadCollection({ schemaName: "test", modelName: "C" }),
    ])

    // Should only call init once despite concurrent requests
    expect(initCallCount).toBe(1)
  })

  test("retries init on transient failure", async () => {
    let attempts = 0
    const mockMcp = {
      initializeSession: mock(async () => {
        attempts++
        if (attempts < 3) {
          throw new Error("Network timeout")
        }
        // Success on 3rd attempt
      }),
      callTool: mock(async () => ({ ok: true, items: [] })),
    }

    const persistence = new MCPPersistence(mockMcp as any)

    // Should retry and eventually succeed
    await persistence.loadCollection({ schemaName: "test", modelName: "Test" })

    expect(attempts).toBe(3)
  })

  test("allows retry after max retries exceeded", async () => {
    let attempts = 0
    const mockMcp = {
      initializeSession: mock(async () => {
        attempts++
        throw new Error("Server down")
      }),
      callTool: mock(async () => ({ ok: true, items: [] })),
    }

    const persistence = new MCPPersistence(mockMcp as any)

    // First attempt - should fail after max retries
    await expect(
      persistence.loadCollection({ schemaName: "test", modelName: "Test" })
    ).rejects.toThrow("Server down")

    const attemptsAfterFirstCall = attempts

    // Reset mock to succeed
    attempts = 0
    mockMcp.initializeSession = mock(async () => {
      attempts++
      // Now succeeds
    })

    // Second attempt - should work (init promise was cleared)
    await persistence.loadCollection({ schemaName: "test", modelName: "Test" })

    // Should have tried again (init promise wasn't permanently cached)
    expect(attempts).toBe(1)
  })

  test("surfaces init error on operation", async () => {
    const mockMcp = {
      initializeSession: mock(async () => {
        throw new Error("Auth failed: invalid API key")
      }),
      callTool: mock(async () => ({ ok: true, items: [] })),
    }

    const persistence = new MCPPersistence(mockMcp as any)

    await expect(
      persistence.loadCollection({ schemaName: "test", modelName: "Test" })
    ).rejects.toThrow("Auth failed")
  })

  test("calls initializeSession before saveCollection", async () => {
    const mockMcp = createMockMCPService()
    const persistence = new MCPPersistence(mockMcp as any)

    await persistence.saveCollection(
      { schemaName: "test", modelName: "Test" },
      { items: {} }
    )

    expect(mockMcp.initializeSession).toHaveBeenCalledTimes(1)
  })

  test("calls initializeSession before loadEntity", async () => {
    const mockMcp = createMockMCPService()
    mockMcp.callTool = mock(async () => ({ ok: true, data: { id: "1" } }))
    const persistence = new MCPPersistence(mockMcp as any)

    await persistence.loadEntity({
      schemaName: "test",
      modelName: "Test",
      entityId: "1",
    })

    expect(mockMcp.initializeSession).toHaveBeenCalledTimes(1)
  })

  test("calls initializeSession before saveEntity", async () => {
    const mockMcp = createMockMCPService()
    mockMcp.callTool = mock(async () => ({ ok: true }))
    const persistence = new MCPPersistence(mockMcp as any)

    await persistence.saveEntity(
      { schemaName: "test", modelName: "Test", entityId: "1" },
      { id: "1", name: "Test" }
    )

    expect(mockMcp.initializeSession).toHaveBeenCalledTimes(1)
  })

  test("calls initializeSession before loadSchema", async () => {
    const mockMcp = createMockMCPService()
    mockMcp.callTool = mock(async () => ({ ok: true, payload: {} }))
    const persistence = new MCPPersistence(mockMcp as any)

    await persistence.loadSchema("test-schema")

    expect(mockMcp.initializeSession).toHaveBeenCalledTimes(1)
  })
})
