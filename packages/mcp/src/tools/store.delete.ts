/**
 * store.delete MCP Tool
 *
 * Deletes entity instances from the specified model collection.
 * Supports both single and batch operations:
 * - Single: id → deleteOne → { ok, data }
 * - Batch: filter (no id) → deleteMany → { ok, count }
 *
 * Tool Requirements:
 * - Tool name: 'store.delete'
 * - Uses CollectionMutatable.deleteOne/deleteMany when available
 * - Falls back to collection.remove + saveAll for legacy collections
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getSnapshot } from "mobx-state-tree"
import { getMetaStore, getRuntimeStore } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * ArkType schema for store.delete parameters
 * - Single: id
 * - Batch: filter (no id)
 */
const Params = t({
  schema: "string",
  model: "string",
  "id?": "string",
  "filter?": "object",
  "workspace?": "string"
})

/**
 * Input parameters for store.delete
 * - Single mode: id
 * - Batch mode: filter (no id)
 */
export interface StoreDeleteParams {
  schema: string
  model: string
  id?: string
  filter?: object
  workspace?: string
}

/**
 * Result structure for store.delete
 * - Single: { ok, data }
 * - Batch: { ok, count }
 */
export interface StoreDeleteResult {
  ok: boolean
  data?: any
  count?: number
  error?: {
    code: string
    message: string
  }
}

// ============================================================================
// Execute Function (Exported for Testing)
// ============================================================================

/**
 * Execute a delete operation against a collection.
 *
 * This function implements the core logic for store.delete tool.
 * It's exported as a standalone function for testability (proper TDD approach).
 *
 * @param args - Delete parameters
 * @returns Delete result with ok status, data/count, or error
 */
export async function executeStoreDelete(
  args: StoreDeleteParams
): Promise<StoreDeleteResult> {
  const { schema, model, id, filter, workspace } = args

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
          message: `Schema '${schema}' not found`
        }
      }
    }

    // 2. Find model within schema
    const modelEntity = schemaEntity.models.find((m: any) => m.name === model)

    if (!modelEntity) {
      return {
        ok: false,
        error: {
          code: "MODEL_NOT_FOUND",
          message: `Model '${model}' not found in schema '${schema}'`
        }
      }
    }

    // 3. Get runtime store from cache (workspace-aware caching)
    const runtimeStore = getRuntimeStore(schemaEntity.id, effectiveWorkspace)
    if (!runtimeStore) {
      return {
        ok: false,
        error: {
          code: "RUNTIME_STORE_NOT_FOUND",
          message: `Runtime store not found for schema ${schemaEntity.id}`
        }
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
          message: `Collection '${collectionName}' not found in runtime store`
        }
      }
    }

    // 5. Determine single vs batch mode
    // Single mode: id is provided
    // Batch mode: filter is provided (no id)
    const isBatchMode = !id && filter

    if (isBatchMode) {
      // Batch mode: delete all matching entities
      if (typeof collection.deleteMany === 'function') {
        const count = await collection.deleteMany(filter)
        return {
          ok: true,
          count
        }
      }

      // Fallback: query + loop delete
      const matches = collection.all().filter((entity: any) => {
        return Object.entries(filter as object).every(([key, value]) => entity[key] === value)
      })

      for (const entity of matches) {
        collection.remove(entity)
      }
      await collection.saveAll()

      return {
        ok: true,
        count: matches.length
      }
    }

    // Validate: either id or filter must be provided
    if (!id) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Either 'id' (single delete) or 'filter' (batch delete) is required"
        }
      }
    }

    // Single mode: delete by id
    // 6. Get entity data before deletion (for return value)
    const entity = collection.get(id)
    if (!entity) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Entity with id '${id}' not found in model '${model}'`
        }
      }
    }

    // Capture data before deletion
    const deletedData = getSnapshot(entity)

    // 7. Delete instance using CollectionMutatable.deleteOne when available
    if (typeof collection.deleteOne === 'function') {
      const deleted = await collection.deleteOne(id)
      if (!deleted) {
        return {
          ok: false,
          error: {
            code: "DELETE_FAILED",
            message: `Failed to delete entity with id '${id}'`
          }
        }
      }
      return {
        ok: true,
        data: deletedData
      }
    }

    // Fallback for collections without CollectionMutatable mixin
    collection.remove(entity)
    await collection.saveAll()

    return {
      ok: true,
      data: deletedData
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "DELETE_ERROR",
        message: error.message || "Failed to delete instance"
      }
    }
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register the store.delete tool on a FastMCP server instance
 *
 * @param server - FastMCP server instance
 */
export function registerStoreDelete(server: FastMCP) {
  server.addTool({
    name: "store.delete",
    description: "Delete entity instances. Single (id) or batch (filter).",
    parameters: Params,
    execute: async (args: StoreDeleteParams) => {
      const result = await executeStoreDelete(args)
      return JSON.stringify(result)
    }
  })
}
