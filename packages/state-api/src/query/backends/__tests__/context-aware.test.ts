/**
 * ContextAwareBackend Tests
 *
 * Tests the schema-aware backend wrapper that applies correct property name
 * normalization using the column-to-property mapping from the schema.
 *
 * This wrapper fixes the data corruption issue where generic snakeToCamel
 * would return wrong property names for consecutive capitals (HTTPSUrl, userID).
 */

import { describe, test, expect, beforeEach } from "bun:test"
import type { Condition } from "../../ast/types"
import type { IBackend, QueryResult, BackendCapabilities } from "../types"
import { ContextAwareBackend } from "../context-aware"
import { createColumnPropertyMap } from "../../execution/utils"
import { FieldCondition } from "@ucast/core"

// ============================================================================
// Mock Backend for Testing
// ============================================================================

/**
 * Mock backend that returns pre-configured rows with snake_case keys.
 * Used to verify ContextAwareBackend applies schema-aware normalization.
 */
class MockBackend implements IBackend {
  public mockRows: Record<string, unknown>[] = []

  capabilities: BackendCapabilities = {
    operators: ["eq", "ne", "gt", "lt"],
    features: { sorting: true, pagination: true },
  }

  async execute<T>(
    _ast: Condition,
    _collection: T[] | string,
    _options?: unknown
  ): Promise<QueryResult<T>> {
    // Return mock rows as-is (snake_case keys)
    return { items: this.mockRows as T[] }
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe("ContextAwareBackend", () => {
  let mockBackend: MockBackend
  let ast: Condition

  beforeEach(() => {
    mockBackend = new MockBackend()
    ast = new FieldCondition("eq", "status", "active")
  })

  // ==========================================================================
  // test-context-aware-01: Basic Wrapper Behavior
  // ==========================================================================
  describe("Basic Wrapper Behavior", () => {
    test("ContextAwareBackend implements IBackend interface", () => {
      // Given: A mock backend and property names
      const propertyNames = ["userId", "createdAt"]
      const columnPropertyMap = createColumnPropertyMap(propertyNames)

      // When: ContextAwareBackend is created
      const wrapper = new ContextAwareBackend(mockBackend, columnPropertyMap)

      // Then: It has execute method and capabilities
      expect(wrapper).toHaveProperty("execute")
      expect(typeof wrapper.execute).toBe("function")
      expect(wrapper).toHaveProperty("capabilities")
      expect(wrapper.capabilities).toBeDefined()
    })

    test("capabilities are inherited from wrapped backend", () => {
      // Given: A mock backend with specific capabilities
      const columnPropertyMap = createColumnPropertyMap(["userId"])
      const wrapper = new ContextAwareBackend(mockBackend, columnPropertyMap)

      // Then: Wrapper exposes same capabilities
      expect(wrapper.capabilities).toEqual(mockBackend.capabilities)
    })

    test("delegates execute to wrapped backend", async () => {
      // Given: Mock backend configured with rows
      mockBackend.mockRows = [{ user_id: 1 }]
      const columnPropertyMap = createColumnPropertyMap(["userId"])
      const wrapper = new ContextAwareBackend(mockBackend, columnPropertyMap)

      // When: execute is called
      const result = await wrapper.execute(ast, "users")

      // Then: Returns result (normalized)
      expect(result.items).toHaveLength(1)
    })
  })

  // ==========================================================================
  // test-context-aware-02: Schema-Aware Normalization
  // ==========================================================================
  describe("Schema-Aware Normalization", () => {
    test("normalizes rows using column-property mapping", async () => {
      // Given: Mock backend returns snake_case rows
      mockBackend.mockRows = [
        { user_id: 1, created_at: "2024-01-01", is_active: true },
      ]

      // Given: Column property map from schema
      const propertyNames = ["userId", "createdAt", "isActive"]
      const columnPropertyMap = createColumnPropertyMap(propertyNames)
      const wrapper = new ContextAwareBackend(mockBackend, columnPropertyMap)

      // When: execute is called
      const result = await wrapper.execute(ast, "users")

      // Then: Rows have correct camelCase property names
      expect(result.items[0]).toEqual({
        userId: 1,
        createdAt: "2024-01-01",
        isActive: true,
      })
    })

    /**
     * CRITICAL TEST: Consecutive capitals round-trip
     *
     * This is the primary test that verifies the fix for the data corruption issue.
     * Without schema-aware normalization:
     * - https_url → httpsUrl (WRONG, should be HTTPSUrl)
     * - user_id → userId (WRONG if original was userID)
     * - id → id (WRONG if original was ID)
     */
    test("handles consecutive capitals correctly", async () => {
      // Given: Mock backend returns rows with columns generated by DDL
      // DDL would create these columns from properties like HTTPSUrl, userID, ID
      mockBackend.mockRows = [
        {
          https_url: "https://example.com",
          xml_parser: "libxml2",
          user_id: "usr_123",
          api_url: "https://api.example.com",
          id: "entity_001",
        },
      ]

      // Given: Property names with consecutive capitals (as in original schema)
      const propertyNames = ["HTTPSUrl", "XMLParser", "userID", "apiURL", "ID"]
      const columnPropertyMap = createColumnPropertyMap(propertyNames)
      const wrapper = new ContextAwareBackend(mockBackend, columnPropertyMap)

      // When: execute is called
      const result = await wrapper.execute(ast, "entities")

      // Then: Rows have ORIGINAL property names with correct capitalization
      const row = result.items[0] as Record<string, unknown>
      expect(row.HTTPSUrl).toBe("https://example.com")
      expect(row.XMLParser).toBe("libxml2")
      expect(row.userID).toBe("usr_123")
      expect(row.apiURL).toBe("https://api.example.com")
      expect(row.ID).toBe("entity_001")

      // Then: Row does NOT have generic camelCase names
      expect(row).not.toHaveProperty("httpsUrl")
      expect(row).not.toHaveProperty("xmlParser")
      expect(row).not.toHaveProperty("userId")
      expect(row).not.toHaveProperty("apiUrl")
      expect(row).not.toHaveProperty("id")
    })

    test("falls back to generic snakeToCamel for unmapped columns", async () => {
      // Given: Mock backend returns rows with extra columns not in schema
      mockBackend.mockRows = [
        {
          user_id: 1,
          extra_column: "value", // Not in property names
          _metadata: "internal", // Not in property names
        },
      ]

      // Given: Only userId is in property names
      const propertyNames = ["userId"]
      const columnPropertyMap = createColumnPropertyMap(propertyNames)
      const wrapper = new ContextAwareBackend(mockBackend, columnPropertyMap)

      // When: execute is called
      const result = await wrapper.execute(ast, "users")

      // Then: Mapped columns use schema names
      expect((result.items[0] as any).userId).toBe(1)

      // Then: Unmapped columns use generic snakeToCamel
      expect((result.items[0] as any).extraColumn).toBe("value")
      expect((result.items[0] as any).Metadata).toBe("internal")
    })
  })

  // ==========================================================================
  // test-context-aware-03: Multiple Rows
  // ==========================================================================
  describe("Multiple Rows", () => {
    test("normalizes all rows in result", async () => {
      // Given: Mock backend returns multiple rows
      mockBackend.mockRows = [
        { id: "1", user_id: "usr_1", https_url: "https://a.com" },
        { id: "2", user_id: "usr_2", https_url: "https://b.com" },
        { id: "3", user_id: "usr_3", https_url: "https://c.com" },
      ]

      // Given: Property names with edge cases
      const propertyNames = ["ID", "userID", "HTTPSUrl"]
      const columnPropertyMap = createColumnPropertyMap(propertyNames)
      const wrapper = new ContextAwareBackend(mockBackend, columnPropertyMap)

      // When: execute is called
      const result = await wrapper.execute(ast, "entities")

      // Then: All rows are normalized correctly
      expect(result.items).toHaveLength(3)
      expect(result.items[0]).toEqual({
        ID: "1",
        userID: "usr_1",
        HTTPSUrl: "https://a.com",
      })
      expect(result.items[1]).toEqual({
        ID: "2",
        userID: "usr_2",
        HTTPSUrl: "https://b.com",
      })
      expect(result.items[2]).toEqual({
        ID: "3",
        userID: "usr_3",
        HTTPSUrl: "https://c.com",
      })
    })

    test("handles empty result", async () => {
      // Given: Mock backend returns empty array
      mockBackend.mockRows = []
      const columnPropertyMap = createColumnPropertyMap(["userId"])
      const wrapper = new ContextAwareBackend(mockBackend, columnPropertyMap)

      // When: execute is called
      const result = await wrapper.execute(ast, "users")

      // Then: Returns empty array
      expect(result.items).toEqual([])
    })
  })

  // ==========================================================================
  // test-context-aware-04: Preserves QueryResult Metadata
  // ==========================================================================
  describe("QueryResult Metadata", () => {
    test("preserves totalCount if present", async () => {
      // Given: Mock backend that returns metadata
      class MockBackendWithMeta implements IBackend {
        capabilities = mockBackend.capabilities
        async execute<T>(): Promise<QueryResult<T>> {
          return {
            items: [{ user_id: 1 }] as T[],
            totalCount: 100,
            hasMore: true,
          }
        }
      }

      const backendWithMeta = new MockBackendWithMeta()
      const columnPropertyMap = createColumnPropertyMap(["userId"])
      const wrapper = new ContextAwareBackend(backendWithMeta, columnPropertyMap)

      // When: execute is called
      const result = await wrapper.execute(ast, "users")

      // Then: Metadata is preserved
      expect(result.totalCount).toBe(100)
      expect(result.hasMore).toBe(true)

      // Then: Items are still normalized
      expect(result.items[0]).toHaveProperty("userId", 1)
    })
  })

  // ==========================================================================
  // test-context-aware-05: Empty Mapping
  // ==========================================================================
  describe("Edge Cases", () => {
    test("works with empty column property map (all fallback)", async () => {
      // Given: Empty property map
      mockBackend.mockRows = [{ user_id: 1, created_at: "2024-01-01" }]
      const columnPropertyMap = createColumnPropertyMap([])
      const wrapper = new ContextAwareBackend(mockBackend, columnPropertyMap)

      // When: execute is called
      const result = await wrapper.execute(ast, "users")

      // Then: All columns use generic snakeToCamel fallback
      expect(result.items[0]).toEqual({
        userId: 1,
        createdAt: "2024-01-01",
      })
    })
  })
})
