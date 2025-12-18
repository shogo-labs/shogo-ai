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

import type { IQueryExecutor } from "@shogo/state-api/query/executors/types"
import type { Condition } from "@shogo/state-api/query/ast/types"
import type { QueryOptions } from "@shogo/state-api/query/backends/types"
import { serializeCondition } from "@shogo/state-api"
import type { MCPService } from "../services/mcpService"

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

    const result = await this.mcp.callTool<StoreQueryResponse<T>>("store.query", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      ast: serializedAst,
      terminal: "toArray",
      ...(options?.orderBy?.[0] && {
        orderBy: {
          field: options.orderBy[0].field,
          direction: options.orderBy[0].direction,
        },
      }),
      ...(options?.skip !== undefined && { skip: options.skip }),
      ...(options?.take !== undefined && { take: options.take }),
    })

    return result.items ?? []
  }

  async first(ast: Condition, options?: QueryOptions): Promise<T | undefined> {
    const serializedAst = serializeCondition(ast)

    const result = await this.mcp.callTool<StoreQueryResponse<T>>("store.query", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      ast: serializedAst,
      terminal: "first",
      ...(options?.orderBy?.[0] && {
        orderBy: {
          field: options.orderBy[0].field,
          direction: options.orderBy[0].direction,
        },
      }),
      ...(options?.skip !== undefined && { skip: options.skip }),
    })

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
    const result = await this.mcp.callTool<StoreBatchResponse<T>>("store.createMany", {
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
    const serializedAst = serializeCondition(ast)

    const result = await this.mcp.callTool<StoreBatchResponse<T>>("store.updateMany", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      ast: serializedAst,
      changes,
    })

    if (!result.ok) {
      throw new Error(result.error?.message ?? "UpdateMany failed")
    }

    return result.count ?? 0
  }

  async deleteMany(ast: Condition): Promise<number> {
    const serializedAst = serializeCondition(ast)

    const result = await this.mcp.callTool<StoreBatchResponse<T>>("store.deleteMany", {
      schema: this.schemaName,
      model: this.modelName,
      workspace: this.workspace,
      ast: serializedAst,
    })

    if (!result.ok) {
      throw new Error(result.error?.message ?? "DeleteMany failed")
    }

    return result.count ?? 0
  }
}
