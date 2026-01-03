/**
 * store.create MCP Tool
 *
 * Creates entity instances in the specified model collection.
 * Supports both single and batch operations:
 * - Single: data is an object → { ok, id, data }
 * - Batch: data is an array → { ok, count, items }
 *
 * Tool Requirements:
 * - Tool name: 'store.create'
 * - Uses CollectionMutatable.insertOne/insertMany when available
 * - Falls back to collection.add + saveAll for legacy collections
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
 * ArkType schema for store.create parameters
 * - data: object for single, array for batch
 */
const Params = t({
  schema: "string",
  model: "string",
  data: "object | object[]",
  "workspace?": "string"
})

/**
 * Input parameters for store.create
 * - data: object for single insert, object[] for batch insert
 */
export interface StoreCreateParams {
  schema: string
  model: string
  data: object | object[]
  workspace?: string
}

/**
 * Result structure for store.create
 * - Single: { ok, id, data }
 * - Batch: { ok, count, items }
 */
export interface StoreCreateResult {
  ok: boolean
  id?: string
  data?: any
  count?: number
  items?: any[]
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

  // Normalize workspace to match schema.load caching behavior
  const effectiveWorkspace = getEffectiveWorkspace(workspace)
  console.log('[store.create] workspace:', workspace, '-> effectiveWorkspace:', effectiveWorkspace)

  try {
    // 1. Find schema in meta-store
    const metaStore = getMetaStore()
    const schemaEntity = metaStore.findSchemaByName(schema)
    console.log('[store.create] schemaEntity:', schemaEntity?.id, 'for schema:', schema)

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
    console.log('[store.create] Getting runtime store for schema:', schemaEntity.id, 'with workspace:', effectiveWorkspace)
    const runtimeStore = getRuntimeStore(schemaEntity.id, effectiveWorkspace)
    console.log('[store.create] Runtime store found:', !!runtimeStore)
    if (!runtimeStore) {
      return {
        ok: false,
        error: {
          code: "RUNTIME_STORE_NOT_FOUND",
          message: `Runtime store not found for schema ${schemaEntity.id}. Call schema.load first with workspace=${effectiveWorkspace}`
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
    const isBatch = Array.isArray(data)

    if (isBatch) {
      // Batch mode: data is an array
      if (typeof collection.insertMany === 'function') {
        const instances = await collection.insertMany(data as object[])
        return {
          ok: true,
          count: instances.length,
          items: instances
        }
      }

      // Fallback for collections without insertMany
      const instances = []
      for (const item of data as object[]) {
        const instance = collection.add(item)
        instances.push(getSnapshot(instance))
      }
      await collection.saveAll()

      return {
        ok: true,
        count: instances.length,
        items: instances
      }
    }

    // Single mode: data is an object
    if (typeof collection.insertOne === 'function') {
      const instance = await collection.insertOne(data)
      return {
        ok: true,
        id: (instance as any).id,
        data: instance
      }
    } else {
      // Fallback for collections without CollectionMutatable mixin
      const instance = collection.add(data)
      await collection.saveAll()

      return {
        ok: true,
        id: instance.id,
        data: getSnapshot(instance)
      }
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
    description:
      "Create entity instances. " +
      "Single: data is an object {id, ...}. " +
      "Batch: data is an array [{id, ...}, {id, ...}] (pass array directly, NOT as JSON string).",
    parameters: Params,
    execute: async (args: StoreCreateParams) => {
      const result = await executeStoreCreate(args)
      return JSON.stringify(result)
    }
  })
}
