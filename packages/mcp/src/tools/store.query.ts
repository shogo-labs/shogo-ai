/**
 * store.query MCP Tool
 *
 * Executes queries against collections using MongoDB-style QueryFilter abstraction.
 * Replaces db.query (raw SQL) with proper query system integration.
 *
 * Tool Requirements:
 * - Tool name: 'store.query'
 * - Uses QueryFilter abstraction (MongoDB-style operators: $gt, $lt, $in, $and, $or, etc.)
 * - Resolves backend via BackendRegistry from environment (Issue 2: DI pattern)
 * - Applies schema-aware normalization via ContextAwareBackend (Issue 1: row normalization)
 * - Supports terminal operations: toArray, first, count, any
 * - Supports ordering and pagination: orderBy, skip, take
 * - Returns { ok: true, count, items } or { ok: false, error }
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import {
  getMetaStore,
  getRuntimeStore,
  parseQuery,
} from "@shogo/state-api"
import { toSnakeCase } from "../../../state-api/src/ddl/utils"
import { getEnv } from "mobx-state-tree"
import type { IEnvironment } from "@shogo/state-api"
// Note: getEffectiveWorkspace is for filesystem operations, not runtime store cache keys

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * ArkType schema for store.query parameters
 */
const Params = t({
  schema: "string",
  model: "string",
  "filter?": "object",
  "orderBy?": "object",  // { field: string, direction: 'asc' | 'desc' }
  "skip?": "number",
  "take?": "number",
  "terminal?": "'toArray' | 'first' | 'count' | 'any'",
  "workspace?": "string",
})

/**
 * Input parameters for store.query
 */
export interface StoreQueryParams {
  schema: string
  model: string
  filter?: object
  orderBy?: { field: string; direction: "asc" | "desc" }
  skip?: number
  take?: number
  terminal?: "toArray" | "first" | "count" | "any"
  workspace?: string
}

/**
 * Result structure for store.query
 */
export interface StoreQueryResult {
  ok: boolean
  items?: any[]
  count?: number
  error?: {
    code: string
    message: string
    context?: any
  }
}

// ============================================================================
// Execute Function (Exported for Testing)
// ============================================================================

/**
 * Execute a query against a collection using QueryFilter abstraction.
 *
 * This function implements the core logic for store.query tool.
 * It's exported as a standalone function for testability (proper TDD approach).
 *
 * @param args - Query parameters
 * @returns Query result with ok status, items/count, or error
 *
 * @remarks
 * Execution flow:
 * 1. Find schema/model in meta-store (same as store.list)
 * 2. Get runtime store from cache (workspace-aware)
 * 3. Resolve backend from runtime store environment
 * 4. Parse QueryFilter into AST
 * 5. Determine table name from model name (using DDL's toSnakeCase)
 * 6. Execute via backend.execute() with appropriate operation type
 * 7. Return formatted result based on terminal operation
 */
export async function executeStoreQuery(
  args: StoreQueryParams
): Promise<StoreQueryResult> {
  const {
    schema,
    model,
    filter,
    orderBy,
    skip,
    take,
    terminal = "toArray",
    workspace,
  } = args

  try {
    // 1. Find schema in meta-store
    const metaStore = getMetaStore()
    const schemaEntity = metaStore.findSchemaByName(schema)

    if (!schemaEntity) {
      return {
        ok: false,
        error: {
          code: "SCHEMA_NOT_FOUND",
          message: `Schema '${schema}' not found`,
        },
      }
    }

    // 2. Find model within schema
    const modelEntity = schemaEntity.models.find((m: any) => m.name === model)

    if (!modelEntity) {
      return {
        ok: false,
        error: {
          code: "MODEL_NOT_FOUND",
          message: `Model '${model}' not found in schema '${schema}'`,
        },
      }
    }

    // 3. Get runtime store from cache (workspace-aware)
    // Use workspace as-is to match how loadSchema caches the store
    const runtimeStore = getRuntimeStore(schemaEntity.id, workspace)

    if (!runtimeStore) {
      return {
        ok: false,
        error: {
          code: "RUNTIME_STORE_NOT_FOUND",
          message: `Runtime store not found for schema '${schema}'. Call schema.load first.`,
        },
      }
    }

    // 4. Resolve backend from runtime store environment
    const runtimeEnv = getEnv<IEnvironment>(runtimeStore)
    const backend = runtimeEnv.services.backendRegistry.resolve(schema, model)

    // 5. Parse QueryFilter into AST
    // Empty filter {} becomes empty AND which matches all items
    const ast = parseQuery(filter || {})

    // 6. Build query options
    // IMPORTANT: Convert orderBy field names from camelCase to snake_case
    // to match database column names (same as DDL generator)
    const options: any = {}
    if (orderBy) {
      options.orderBy = {
        field: toSnakeCase(orderBy.field),
        direction: orderBy.direction,
      }
    }
    // SQLite requires LIMIT before OFFSET, so if skip is provided without take,
    // we need to provide a large LIMIT value to effectively get all remaining rows
    if (skip !== undefined) {
      options.skip = skip
      if (take === undefined) {
        options.take = 999999 // Large number to get all remaining rows
      }
    }
    if (take !== undefined) options.take = take

    // 7. Determine table name from model name (same as DDL generator)
    const tableName = toSnakeCase(model)

    // 8. Execute query based on terminal operation
    let result: any

    switch (terminal) {
      case "count":
        // COUNT(*) query returns { items: [{ "COUNT(*)": N }] }
        options.operation = "count"
        result = await backend.execute(ast, tableName, options)
        const countValue = result.items[0]
          ? Object.values(result.items[0])[0]
          : 0
        return {
          ok: true,
          count: countValue as number,
        }

      case "any":
        // EXISTS query returns { items: [{ ?column?: 1 }] } or { items: [] }
        options.operation = "exists"
        result = await backend.execute(ast, tableName, options)
        return {
          ok: true,
          count: result.items.length > 0 ? 1 : 0,
          items: [],
        }

      case "first":
        // SELECT with LIMIT 1
        options.take = 1
        result = await backend.execute(ast, tableName, options)
        return {
          ok: true,
          count: result.items.length,
          items: result.items.slice(0, 1),
        }

      case "toArray":
      default:
        // Standard SELECT query
        result = await backend.execute(ast, tableName, options)
        return {
          ok: true,
          count: result.items.length,
          items: result.items,
        }
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "QUERY_EXECUTION_ERROR",
        message: error.message || "Query execution failed",
        context: { schema, model, filter },
      },
    }
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register the store.query tool on a FastMCP server instance
 *
 * @param server - FastMCP server instance
 */
export function registerStoreQuery(server: FastMCP) {
  server.addTool({
    name: "store.query",
    description:
      "Query a collection using MongoDB-style filters. Supports operators like $gt, $lt, $in, $and, $or, and terminal operations (toArray, first, count, any).",
    parameters: Params,
    execute: async (args: any) => {
      const result = await executeStoreQuery(args as StoreQueryParams)
      return JSON.stringify(result)
    },
  })
}
