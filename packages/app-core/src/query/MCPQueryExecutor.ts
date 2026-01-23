/**
 * MCPQueryExecutor
 *
 * Browser-side query executor that proxies to MCP tools for data operations.
 * Implements IQueryExecutor interface for seamless integration with the query system.
 *
 * Each method serializes the query AST and delegates to the appropriate MCP tool:
 * - select/first/count/exists → store.query
 * - insert → store.create
 * - update → store.update
 * - delete → store.delete
 * - insertMany → store.createMany (requires batch tools)
 * - updateMany → store.updateMany (requires batch tools)
 * - deleteMany → store.deleteMany (requires batch tools)
 */

import type { IQueryExecutor, Condition, QueryOptions, OrderByClause } from "@shogo/state-api"
import { serializeCondition } from "@shogo/state-api"

/**
 * Extract first orderBy clause from QueryOptions.orderBy
 * Handles both single OrderByClause and OrderByClause[] cases.
 */
function getFirstOrderBy(orderBy: OrderByClause | OrderByClause[] | undefined): OrderByClause | undefined {
  if (!orderBy) return undefined
  return Array.isArray(orderBy) ? orderBy[0] : orderBy
}
import type { MCPService } from "../services/MCPService"

// =============================================================================
// Response Types
// =============================================================================

interface StoreQueryResponse<T> {
  ok: boolean
  items?: T[]
  count?: number
  error?: { code: string; message: string }
}

interface StoreMutationResponse<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface StoreBatchResponse<T> {
  ok: boolean
  count?: number
  items?: T[]
  error?: { code: string; message: string }
}

// =============================================================================
// MCPQueryExecutor
// =============================================================================

/**
 * Query executor that proxies to MCP tools.
 *
 * @remarks
 * Uses 'remote' executorType which triggers MST sync behavior -
 * results from queries are synced back into the local MST collection.
 */
export class MCPQueryExecutor<T> implements IQueryExecutor<T> {
  readonly executorType = "remote" as const

  constructor(
    private mcp: MCPService,
    private schemaName: string,
    private modelName: string,
    private workspace?: string
  ) {}

  // ===========================================================================
  // Query Operations
  // ===========================================================================

  async select(ast: Condition, options?: QueryOptions): Promise<T[]> {
    const serializedAst = serializeCondition(ast)
    const firstOrderBy = getFirstOrderBy(options?.orderBy)

    const result = await this.mcp.callTool<StoreQueryResponse<T>>("store.query", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      ast: serializedAst,
      terminal: "toArray",
      ...(firstOrderBy && {
        orderBy: {
          field: firstOrderBy.field,
          direction: firstOrderBy.direction,
        },
      }),
      ...(options?.skip !== undefined && { skip: options.skip }),
      ...(options?.take !== undefined && { take: options.take }),
    })

    if (!result.ok) {
      throw new Error(`Query failed: ${result.error?.message || "Unknown error"}`)
    }

    return result.items ?? []
  }

  async first(ast: Condition, options?: QueryOptions): Promise<T | undefined> {
    const serializedAst = serializeCondition(ast)
    const firstOrderBy = getFirstOrderBy(options?.orderBy)

    const result = await this.mcp.callTool<StoreQueryResponse<T>>("store.query", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      ast: serializedAst,
      terminal: "first",
      ...(firstOrderBy && {
        orderBy: {
          field: firstOrderBy.field,
          direction: firstOrderBy.direction,
        },
      }),
      ...(options?.skip !== undefined && { skip: options.skip }),
    })

    if (!result.ok) {
      throw new Error(`Query failed: ${result.error?.message || "Unknown error"}`)
    }

    return result.items?.[0]
  }

  async count(ast: Condition): Promise<number> {
    const serializedAst = serializeCondition(ast)

    const result = await this.mcp.callTool<StoreQueryResponse<T>>("store.query", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      ast: serializedAst,
      terminal: "count",
    })

    if (!result.ok) {
      throw new Error(`Query failed: ${result.error?.message || "Unknown error"}`)
    }

    return result.count ?? 0
  }

  async exists(ast: Condition): Promise<boolean> {
    const serializedAst = serializeCondition(ast)

    const result = await this.mcp.callTool<StoreQueryResponse<T>>("store.query", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      ast: serializedAst,
      terminal: "any",
    })

    if (!result.ok) {
      throw new Error(`Query failed: ${result.error?.message || "Unknown error"}`)
    }

    return (result.count ?? 0) > 0
  }

  // ===========================================================================
  // Single Mutation Operations
  // ===========================================================================

  async insert(entity: Partial<T>): Promise<T> {
    const result = await this.mcp.callTool<StoreMutationResponse<T>>("store.create", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      data: entity,
    })

    if (!result.ok || !result.data) {
      throw new Error(result.error?.message ?? "Insert failed")
    }

    return result.data
  }

  async update(id: string, changes: Partial<T>): Promise<T | undefined> {
    const result = await this.mcp.callTool<StoreMutationResponse<T>>("store.update", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      id,
      changes,
    })

    if (!result.ok) {
      // NOT_FOUND returns undefined, not error
      if (result.error?.code === "NOT_FOUND") {
        return undefined
      }
      throw new Error(result.error?.message ?? "Update failed")
    }

    return result.data
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.mcp.callTool<StoreMutationResponse<T>>("store.delete", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      id,
    })

    return result.ok
  }

  // ===========================================================================
  // Batch Mutation Operations
  // ===========================================================================

  async insertMany(entities: Partial<T>[]): Promise<T[]> {
    // Uses enhanced store.create which accepts array for batch operations
    const result = await this.mcp.callTool<StoreBatchResponse<T>>("store.create", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      data: entities,
    })

    if (!result.ok) {
      throw new Error(result.error?.message ?? "InsertMany failed")
    }

    return result.items ?? []
  }

  async updateMany(ast: Condition, changes: Partial<T>): Promise<number> {
    // Convert AST to filter object for enhanced store.update
    const filter = this.conditionToFilter(ast)

    const result = await this.mcp.callTool<StoreBatchResponse<T>>("store.update", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      filter,
      changes,
    })

    if (!result.ok) {
      throw new Error(result.error?.message ?? "UpdateMany failed")
    }

    return result.count ?? 0
  }

  async deleteMany(ast: Condition): Promise<number> {
    // Convert AST to filter object for enhanced store.delete
    const filter = this.conditionToFilter(ast)

    const result = await this.mcp.callTool<StoreBatchResponse<T>>("store.delete", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      filter,
    })

    if (!result.ok) {
      throw new Error(result.error?.message ?? "DeleteMany failed")
    }

    return result.count ?? 0
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Convert a Condition AST to a simple filter object.
   * Supports equality conditions; complex conditions throw.
   */
  private conditionToFilter(condition: Condition): Record<string, unknown> {
    const serialized = serializeCondition(condition)

    // Simple field equality: { field: value }
    if (serialized.type === "field" && serialized.operator === "eq") {
      return { [serialized.field]: serialized.value }
    }

    // Compound AND: combine all field equalities
    if (serialized.type === "compound" && serialized.operator === "and") {
      const filter: Record<string, unknown> = {}
      for (const child of serialized.value) {
        if (child.type === "field" && child.operator === "eq") {
          filter[child.field] = child.value
        } else {
          throw new Error("Complex conditions not yet supported in batch operations")
        }
      }
      return filter
    }

    throw new Error("Complex conditions not yet supported in batch operations")
  }
}
