/**
 * MCPQueryExecutor Tests
 *
 * Tests for the browser-side query executor that proxies to MCP tools.
 * Uses mocked MCPService to verify correct tool calls.
 *
 * TDD RED Tests - Written before implementation.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { MCPQueryExecutor } from "../MCPQueryExecutor"
import type { MCPService } from "../../services/mcpService"
import { FieldCondition, CompoundCondition } from "@shogo/state-api"

// =============================================================================
// Mock MCPService
// =============================================================================

function createMockMCPService() {
  return {
    callTool: mock(() => Promise.resolve({ ok: true })),
  } as unknown as MCPService
}

// =============================================================================
// Tests
// =============================================================================

describe("MCPQueryExecutor", () => {
  let mockMcp: ReturnType<typeof createMockMCPService>
  let executor: MCPQueryExecutor<any>

  beforeEach(() => {
    mockMcp = createMockMCPService()
    executor = new MCPQueryExecutor(mockMcp, "test-schema", "Task", "test-workspace")
  })

  describe("executorType", () => {
    test('is "remote" for MST sync behavior', () => {
      expect(executor.executorType).toBe("remote")
    })
  })

  describe("select()", () => {
    test("calls store.query with serialized AST", async () => {
      // Given: A field condition
      const condition = new FieldCondition("eq", "status", "active")
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, items: [{ id: "1", status: "active" }], count: 1 })
      )

      // When: select() is called
      const result = await executor.select(condition)

      // Then: store.query is called with serialized AST
      expect(mockMcp.callTool).toHaveBeenCalledTimes(1)
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.query")
      expect(args.schema).toBe("test-schema")
      expect(args.model).toBe("Task")
      expect(args.workspace).toBe("test-workspace")
      expect(args.ast).toEqual({
        type: "field",
        operator: "eq",
        field: "status",
        value: "active",
      })
      expect(args.terminal).toBe("toArray")
    })

    test("passes orderBy, skip, take options", async () => {
      const condition = new FieldCondition("eq", "status", "active")
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, items: [], count: 0 })
      )

      // When: select() is called with options
      await executor.select(condition, {
        orderBy: [{ field: "priority", direction: "desc" }],
        skip: 10,
        take: 5,
      })

      // Then: Options are passed to store.query
      const [, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(args.orderBy).toEqual({ field: "priority", direction: "desc" })
      expect(args.skip).toBe(10)
      expect(args.take).toBe(5)
    })

    test("returns items array from response", async () => {
      const condition = new FieldCondition("eq", "status", "active")
      const mockItems = [
        { id: "1", title: "Task One" },
        { id: "2", title: "Task Two" },
      ]
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, items: mockItems, count: 2 })
      )

      // When: select() is called
      const result = await executor.select(condition)

      // Then: Returns items from response
      expect(result).toEqual(mockItems)
    })
  })

  describe("first()", () => {
    test('calls store.query with terminal: "first"', async () => {
      const condition = new FieldCondition("eq", "id", "1")
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, items: [{ id: "1" }], count: 1 })
      )

      // When: first() is called
      await executor.first(condition)

      // Then: store.query called with terminal: "first"
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.query")
      expect(args.terminal).toBe("first")
    })

    test("returns single item or undefined", async () => {
      const condition = new FieldCondition("eq", "id", "1")

      // Case 1: Item found
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, items: [{ id: "1", title: "Found" }], count: 1 })
      )
      const found = await executor.first(condition)
      expect(found).toEqual({ id: "1", title: "Found" })

      // Case 2: Not found
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, items: [], count: 0 })
      )
      const notFound = await executor.first(condition)
      expect(notFound).toBeUndefined()
    })
  })

  describe("count()", () => {
    test('calls store.query with terminal: "count"', async () => {
      const condition = new FieldCondition("eq", "status", "active")
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 5 })
      )

      // When: count() is called
      await executor.count(condition)

      // Then: store.query called with terminal: "count"
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.query")
      expect(args.terminal).toBe("count")
    })

    test("returns number", async () => {
      const condition = new FieldCondition("eq", "status", "active")
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 42 })
      )

      const result = await executor.count(condition)
      expect(result).toBe(42)
    })
  })

  describe("exists()", () => {
    test('calls store.query with terminal: "any"', async () => {
      const condition = new FieldCondition("eq", "status", "active")
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 1, items: [] })
      )

      // When: exists() is called
      await executor.exists(condition)

      // Then: store.query called with terminal: "any"
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.query")
      expect(args.terminal).toBe("any")
    })

    test("returns boolean", async () => {
      const condition = new FieldCondition("eq", "status", "active")

      // Case 1: Exists
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 1 })
      )
      const exists = await executor.exists(condition)
      expect(exists).toBe(true)

      // Case 2: Does not exist
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 0 })
      )
      const notExists = await executor.exists(condition)
      expect(notExists).toBe(false)
    })
  })

  describe("insert()", () => {
    test("calls store.create with entity data", async () => {
      const entity = { title: "New Task", status: "pending" }
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, data: { id: "generated-id", ...entity } })
      )

      // When: insert() is called
      await executor.insert(entity)

      // Then: store.create is called
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.create")
      expect(args.schema).toBe("test-schema")
      expect(args.model).toBe("Task")
      expect(args.data).toEqual(entity)
    })

    test("returns created entity", async () => {
      const entity = { title: "New Task" }
      const createdEntity = { id: "abc-123", title: "New Task", status: "pending" }
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, data: createdEntity })
      )

      const result = await executor.insert(entity)
      expect(result).toEqual(createdEntity)
    })
  })

  describe("update()", () => {
    test("calls store.update with id and changes", async () => {
      const changes = { title: "Updated Title" }
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, data: { id: "1", title: "Updated Title" } })
      )

      // When: update() is called
      await executor.update("1", changes)

      // Then: store.update is called
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.update")
      expect(args.schema).toBe("test-schema")
      expect(args.model).toBe("Task")
      expect(args.id).toBe("1")
      expect(args.changes).toEqual(changes)
    })

    test("returns updated entity or undefined", async () => {
      // Case 1: Found and updated
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, data: { id: "1", title: "Updated" } })
      )
      const updated = await executor.update("1", { title: "Updated" })
      expect(updated).toEqual({ id: "1", title: "Updated" })

      // Case 2: Not found
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } })
      )
      const notFound = await executor.update("999", { title: "X" })
      expect(notFound).toBeUndefined()
    })
  })

  describe("delete()", () => {
    test("calls store.delete with id", async () => {
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, data: { id: "1" } })
      )

      // When: delete() is called
      await executor.delete("1")

      // Then: store.delete is called
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.delete")
      expect(args.schema).toBe("test-schema")
      expect(args.model).toBe("Task")
      expect(args.id).toBe("1")
    })

    test("returns true on success, false on not found", async () => {
      // Case 1: Deleted
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true })
      )
      const deleted = await executor.delete("1")
      expect(deleted).toBe(true)

      // Case 2: Not found
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } })
      )
      const notFound = await executor.delete("999")
      expect(notFound).toBe(false)
    })
  })

  describe("insertMany()", () => {
    test("calls store.create with entities array (batch mode)", async () => {
      const entities = [
        { title: "Task 1" },
        { title: "Task 2" },
      ]
      mockMcp.callTool = mock(() =>
        Promise.resolve({
          ok: true,
          count: 2,
          items: [
            { id: "1", title: "Task 1" },
            { id: "2", title: "Task 2" },
          ],
        })
      )

      // When: insertMany() is called
      await executor.insertMany(entities)

      // Then: store.create is called with array (batch mode)
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.create")
      expect(args.schema).toBe("test-schema")
      expect(args.model).toBe("Task")
      expect(args.data).toEqual(entities)
    })

    test("returns all created entities", async () => {
      const entities = [{ title: "Task 1" }]
      const created = [{ id: "1", title: "Task 1" }]
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 1, items: created })
      )

      const result = await executor.insertMany(entities)
      expect(result).toEqual(created)
    })
  })

  describe("updateMany()", () => {
    test("calls store.update with filter and changes (batch mode)", async () => {
      const condition = new FieldCondition("eq", "status", "pending")
      const changes = { status: "active" }
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 3 })
      )

      // When: updateMany() is called
      await executor.updateMany(condition, changes)

      // Then: store.update is called with filter (batch mode)
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.update")
      expect(args.schema).toBe("test-schema")
      expect(args.model).toBe("Task")
      expect(args.workspace).toBe("test-workspace")
      expect(args.filter).toEqual({ status: "pending" })
      expect(args.changes).toEqual(changes)
    })

    test("returns count of updated entities", async () => {
      const condition = new FieldCondition("eq", "status", "pending")
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 5 })
      )

      const result = await executor.updateMany(condition, { status: "active" })
      expect(result).toBe(5)
    })
  })

  describe("deleteMany()", () => {
    test("calls store.delete with filter (batch mode)", async () => {
      const condition = new FieldCondition("eq", "status", "archived")
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 2 })
      )

      // When: deleteMany() is called
      await executor.deleteMany(condition)

      // Then: store.delete is called with filter (batch mode)
      const [toolName, args] = (mockMcp.callTool as any).mock.calls[0]
      expect(toolName).toBe("store.delete")
      expect(args.schema).toBe("test-schema")
      expect(args.model).toBe("Task")
      expect(args.workspace).toBe("test-workspace")
      expect(args.filter).toEqual({ status: "archived" })
    })

    test("returns count of deleted entities", async () => {
      const condition = new FieldCondition("eq", "status", "archived")
      mockMcp.callTool = mock(() =>
        Promise.resolve({ ok: true, count: 10 })
      )

      const result = await executor.deleteMany(condition)
      expect(result).toBe(10)
    })
  })
})
