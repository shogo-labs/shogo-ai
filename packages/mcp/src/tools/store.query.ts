/**
 * store.query MCP Tool
 *
 * Executes queries against collections using the CollectionQueryable abstraction.
 * Leverages collection.query() fluent API for backend-agnostic query execution.
 *
 * Tool Requirements:
 * - Tool name: 'store.query'
 * - Uses CollectionQueryable.query() for isomorphic query building
 * - Supports MongoDB-style filter operators: $gt, $lt, $in, $and, $or, etc.
 * - Supports terminal operations: toArray, first, count, any
 * - Supports ordering and pagination: orderBy, skip, take
 * - Returns { ok: true, count, items } or { ok: false, error }
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getMetaStore, getRuntimeStore, deserializeCondition } from "@shogo/state-api"
import type { SerializedCondition } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate that an AST object has the expected structure.
 * Valid AST must be either:
 * - Field condition: { type: 'field', operator: string, field: string, value: any }
 * - Compound condition: { type: 'compound', operator: string, value: SerializedCondition[] }
 */
function isValidAst(ast: any): ast is SerializedCondition {
  if (!ast || typeof ast !== 'object') return false

  if (ast.type === 'field') {
    return (
      typeof ast.operator === 'string' &&
      typeof ast.field === 'string' &&
      'value' in ast
    )
  }

  if (ast.type === 'compound') {
    return (
      typeof ast.operator === 'string' &&
      Array.isArray(ast.value) &&
      ast.value.every(isValidAst)
    )
  }

  return false
}

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
  "ast?": "object",  // Serialized AST condition (takes precedence over filter)
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
  ast?: SerializedCondition  // Serialized AST condition (takes precedence over filter)
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
 * Execute a query against a collection using CollectionQueryable abstraction.
 *
 * This function implements the core logic for store.query tool.
 * It's exported as a standalone function for testability (proper TDD approach).
 *
 * @param args - Query parameters
 * @returns Query result with ok status, items/count, or error
 *
 * @remarks
 * Execution flow:
 * 1. Find schema/model in meta-store
 * 2. Get runtime store from cache (workspace-aware)
 * 3. Access collection and build query via IQueryable fluent API
 * 4. Execute terminal operation
 * 5. Return formatted result
 */
export async function executeStoreQuery(
  args: StoreQueryParams
): Promise<StoreQueryResult> {
  const {
    schema,
    model,
    filter,
    ast,
    orderBy,
    skip,
    take,
    terminal = "toArray",
    workspace,
  } = args

  // Normalize workspace to match schema.load caching behavior
  const effectiveWorkspace = getEffectiveWorkspace(workspace)

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

    // 3. Get runtime store from cache (workspace-aware caching)
    const runtimeStore = getRuntimeStore(schemaEntity.id, effectiveWorkspace)

    if (!runtimeStore) {
      return {
        ok: false,
        error: {
          code: "RUNTIME_STORE_NOT_FOUND",
          message: `Runtime store not found for schema '${schema}'. Call schema.load first.`,
        },
      }
    }

    // 4. Access collection
    const collectionName = modelEntity.collectionName
    const collection = runtimeStore[collectionName]

    if (!collection) {
      return {
        ok: false,
        error: {
          code: "COLLECTION_NOT_FOUND",
          message: `Collection '${collectionName}' not found in runtime store`,
        },
      }
    }

    // 5. Build query via IQueryable fluent API
    let q = collection.query()

    // AST takes precedence over filter
    if (ast) {
      // Validate AST structure
      if (!isValidAst(ast)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid AST structure. Expected { type: 'field'|'compound', operator, ... }",
            context: { ast },
          },
        }
      }
      // Deserialize and use pre-built AST condition
      const condition = deserializeCondition(ast)
      q = q.whereCondition(condition)
    } else if (filter && Object.keys(filter).length > 0) {
      q = q.where(filter)
    }
    if (orderBy) {
      q = q.orderBy(orderBy.field, orderBy.direction)
    }
    if (skip !== undefined) {
      q = q.skip(skip)
    }
    if (take !== undefined) {
      q = q.take(take)
    }

    // 6. Execute terminal operation
    switch (terminal) {
      case "count": {
        const count = await q.count()
        return { ok: true, count }
      }

      case "any": {
        const exists = await q.any()
        return { ok: true, count: exists ? 1 : 0, items: [] }
      }

      case "first": {
        const first = await q.first()
        return {
          ok: true,
          count: first ? 1 : 0,
          items: first ? [first] : [],
        }
      }

      case "toArray":
      default: {
        const items = await q.toArray()
        return { ok: true, count: items.length, items }
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
