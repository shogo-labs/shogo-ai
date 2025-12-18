/**
 * store.delete MCP Tool
 *
 * Deletes an entity instance by ID from the specified model collection.
 * Uses CollectionMutatable.deleteOne for proper MST state + backend persistence.
 *
 * Tool Requirements:
 * - Tool name: 'store.delete'
 * - Uses CollectionMutatable.deleteOne when available
 * - Falls back to collection.remove + saveAll for legacy collections
 * - Returns { ok: true, data: <deleted entity> } or { ok: false, error }
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getSnapshot } from "mobx-state-tree"
import { getMetaStore } from "@shogo/state-api"
import { getRuntimeStore } from "@shogo/state-api"

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * ArkType schema for store.delete parameters
 */
const Params = t({
  schema: "string",
  model: "string",
  id: "string",
  "workspace?": "string"
})

/**
 * Input parameters for store.delete
 */
export interface StoreDeleteParams {
  schema: string
  model: string
  id: string
  workspace?: string
}

/**
 * Result structure for store.delete
 */
export interface StoreDeleteResult {
  ok: boolean
  data?: any
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
 * @returns Delete result with ok status, data (deleted entity), or error
 */
export async function executeStoreDelete(
  args: StoreDeleteParams
): Promise<StoreDeleteResult> {
  const { schema, model, id, workspace } = args

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
    const runtimeStore = getRuntimeStore(schemaEntity.id, workspace)
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

    // 5. Get entity data before deletion (for return value)
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

    // 6. Delete instance using CollectionMutatable.deleteOne when available
    // This handles both MST state and backend persistence in one operation
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
    description: "Delete an entity instance by ID",
    parameters: Params,
    execute: async (args: StoreDeleteParams) => {
      const result = await executeStoreDelete(args)
      return JSON.stringify(result)
    }
  })
}
