/**
 * store.update MCP Tool
 *
 * Updates entity instances' properties.
 * Supports both single and batch operations:
 * - Single: id + changes → updateOne → { ok, data }
 * - Batch: filter + changes (no id) → updateMany → { ok, count }
 *
 * Tool Requirements:
 * - Tool name: 'store.update'
 * - Uses CollectionMutatable.updateOne/updateMany when available
 * - Falls back to applySnapshot + saveAll for legacy collections
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getSnapshot, applySnapshot } from "mobx-state-tree"
import { getMetaStore, getRuntimeStore } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * ArkType schema for store.update parameters
 * - Single: id + changes
 * - Batch: filter + changes (no id)
 */
const Params = t({
  schema: "string",
  model: "string",
  "id?": "string",
  "filter?": "object",
  changes: "object",
  "workspace?": "string"
})

/**
 * Input parameters for store.update
 * - Single mode: id + changes
 * - Batch mode: filter + changes (no id)
 */
export interface StoreUpdateParams {
  schema: string
  model: string
  id?: string
  filter?: object
  changes: object
  workspace?: string
}

/**
 * Result structure for store.update
 * - Single: { ok, data }
 * - Batch: { ok, count }
 */
export interface StoreUpdateResult {
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
 * Execute an update operation against a collection.
 *
 * This function implements the core logic for store.update tool.
 * It's exported as a standalone function for testability (proper TDD approach).
 *
 * @param args - Update parameters
 * @returns Update result with ok status, data, or error
 */
export async function executeStoreUpdate(
  args: StoreUpdateParams
): Promise<StoreUpdateResult> {
  const { schema, model, id, filter, changes, workspace } = args

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

    // 5. Validate changes parameter
    if (!changes || typeof changes !== "object") {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Changes must be an object"
        }
      }
    }

    // 6. Determine single vs batch mode
    // Single mode: id is provided
    // Batch mode: filter is provided (no id)
    const isBatchMode = !id && filter

    if (isBatchMode) {
      // Batch mode: update all matching entities
      if (typeof collection.updateMany === 'function') {
        const count = await collection.updateMany(filter, changes)
        return {
          ok: true,
          count
        }
      }

      // Fallback: query + loop update
      const matches = collection.all().filter((entity: any) => {
        return Object.entries(filter as object).every(([key, value]) => entity[key] === value)
      })

      for (const entity of matches) {
        const currentSnapshot = getSnapshot(entity) as Record<string, any>
        const updatedSnapshot = { ...currentSnapshot, ...(changes as Record<string, any>) }
        applySnapshot(entity, updatedSnapshot)
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
          message: "Either 'id' (single update) or 'filter' (batch update) is required"
        }
      }
    }

    // Single mode: update by id
    if (typeof collection.updateOne === 'function') {
      const updated = await collection.updateOne(id, changes)
      if (!updated) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Entity with id '${id}' not found in model '${model}'`
          }
        }
      }
      return {
        ok: true,
        data: updated
      }
    }

    // Fallback for collections without CollectionMutatable mixin
    const instance = collection.get(id)
    if (!instance) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Entity with id '${id}' not found in model '${model}'`
        }
      }
    }

    const currentSnapshot = getSnapshot(instance) as Record<string, any>
    const updatedSnapshot = { ...currentSnapshot, ...(changes as Record<string, any>) }
    applySnapshot(instance, updatedSnapshot)
    await collection.saveAll()

    return {
      ok: true,
      data: getSnapshot(instance)
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: error.message || "Failed to update instance"
      }
    }
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register the store.update tool on a FastMCP server instance
 *
 * @param server - FastMCP server instance
 */
export function registerStoreUpdate(server: FastMCP) {
  server.addTool({
    name: "store.update",
    description: "Update entity instances. Single (id + changes) or batch (filter + changes).",
    parameters: Params,
    execute: async (args: StoreUpdateParams) => {
      const result = await executeStoreUpdate(args)
      return JSON.stringify(result)
    }
  })
}
