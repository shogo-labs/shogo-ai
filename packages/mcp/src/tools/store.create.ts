/**
 * store.create MCP Tool
 *
 * Creates a new entity instance in the specified model collection.
 * Uses CollectionMutatable.insertOne for proper MST state + backend persistence.
 *
 * Tool Requirements:
 * - Tool name: 'store.create'
 * - Uses CollectionMutatable.insertOne when available
 * - Falls back to collection.add + saveAll for legacy collections
 * - Returns { ok: true, id, data } or { ok: false, error }
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getSnapshot } from "mobx-state-tree"
import { getMetaStore } from "@shogo/state-api"
import { getRuntimeStore } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * ArkType schema for store.create parameters
 */
const Params = t({
  schema: "string",
  model: "string",
  data: "object",
  "workspace?": "string"
})

/**
 * Input parameters for store.create
 */
export interface StoreCreateParams {
  schema: string
  model: string
  data: object
  workspace?: string
}

/**
 * Result structure for store.create
 */
export interface StoreCreateResult {
  ok: boolean
  id?: string
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
 * Execute a create operation against a collection.
 *
 * This function implements the core logic for store.create tool.
 * It's exported as a standalone function for testability (proper TDD approach).
 *
 * @param args - Create parameters
 * @returns Create result with ok status, id/data, or error
 */
export async function executeStoreCreate(
  args: StoreCreateParams
): Promise<StoreCreateResult> {
  const { schema, model, data, workspace } = args

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

    // 3. Get runtime store from cache (Unit 3: workspace-aware caching)
    const effectiveWorkspace = getEffectiveWorkspace(workspace)
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

    // 5. Create instance using CollectionMutatable.insertOne when available
    // This handles both MST state and backend persistence in one operation
    if (typeof collection.insertOne === 'function') {
      const instance = await collection.insertOne(data)
      return {
        ok: true,
        id: (instance as any).id,
        data: instance
      }
    }

    // Fallback for collections without CollectionMutatable mixin
    const instance = collection.add(data)
    await collection.saveAll()

    return {
      ok: true,
      id: instance.id,
      data: getSnapshot(instance)
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: error.message || "Failed to create instance"
      }
    }
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register the store.create tool on a FastMCP server instance
 *
 * @param server - FastMCP server instance
 */
export function registerStoreCreate(server: FastMCP) {
  server.addTool({
    name: "store.create",
    description: "Create a new entity instance in the specified model",
    parameters: Params,
    execute: async (args: StoreCreateParams) => {
      const result = await executeStoreCreate(args)
      return JSON.stringify(result)
    }
  })
}
