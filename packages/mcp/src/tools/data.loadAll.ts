import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getMetaStore } from "@shogo/state-api"
import { getRuntimeStore } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

const Params = t({
  schemaName: "string",
  "workspace?": "string"
})

/**
 * Load all collections' data from disk into the runtime store.
 *
 * This tool:
 * 1. Finds the schema in the meta-store
 * 2. Gets the cached runtime store
 * 3. Iterates all collection properties
 * 4. Calls collection.loadAll() on each
 * 5. Returns summary of loaded collections
 *
 * Prerequisites:
 * - Schema must be loaded first (use schema.load)
 * - Runtime store must exist for the schema
 *
 * Example usage:
 * ```
 * // Load schema first
 * await schema.load({ name: "my-schema", workspace: "/path/to/workspace" })
 *
 * // Then load all collection data
 * await data.loadAll({ schemaName: "my-schema", workspace: "/path/to/workspace" })
 * ```
 */
export function registerDataLoadAll(server: FastMCP) {
  server.addTool({
    name: "data.loadAll",
    description: "Load all collections' data from disk for a schema",
    parameters: Params,
    execute: async (args: any) => {
      const { schemaName, workspace } = args as { schemaName: string; workspace?: string }

      // If no workspace provided, use monorepo's .schemas directory
      const effectiveWorkspace = getEffectiveWorkspace(workspace)

      try {
        // 1. Find schema in meta-store
        const metaStore = getMetaStore()
        const schema = metaStore.findSchemaByName(schemaName)

        if (!schema) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "SCHEMA_NOT_FOUND",
              message: `Schema '${schemaName}' not found in meta-store. Did you call schema.load first?`
            }
          })
        }

        // 2. Get runtime store from cache
        const runtimeStore = getRuntimeStore(schema.id, effectiveWorkspace)
        if (!runtimeStore) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "RUNTIME_STORE_NOT_FOUND",
              message: `Runtime store not found for schema '${schemaName}' (id: ${schema.id}). Did you call schema.load first?`
            }
          })
        }

        // 3. Get all models from schema
        const models = schema.toModelDescriptors

        if (!models || models.length === 0) {
          return JSON.stringify({
            ok: true,
            schemaName,
            collections: [],
            totalEntities: 0,
            message: "Schema has no models defined"
          })
        }

        // 4. Load each collection
        const results: Array<{
          model: string
          collectionName: string
          count: number
          success: boolean
          error?: string
        }> = []

        let totalEntities = 0

        for (const modelDescriptor of models) {
          const collectionName = modelDescriptor.collectionName
          const collection = runtimeStore[collectionName]

          if (!collection) {
            results.push({
              model: modelDescriptor.name,
              collectionName,
              count: 0,
              success: false,
              error: "Collection not found in runtime store"
            })
            continue
          }

          if (typeof collection.loadAll !== 'function') {
            results.push({
              model: modelDescriptor.name,
              collectionName,
              count: 0,
              success: false,
              error: "Collection does not have loadAll method (mixin not applied?)"
            })
            continue
          }

          try {
            // Load data using CollectionPersistable mixin
            await collection.loadAll()
            const count = collection.all().length
            totalEntities += count

            results.push({
              model: modelDescriptor.name,
              collectionName,
              count,
              success: true
            })
          } catch (error: any) {
            results.push({
              model: modelDescriptor.name,
              collectionName,
              count: 0,
              success: false,
              error: error.message || "Unknown error during load"
            })
          }
        }

        // 5. Build summary
        const successCount = results.filter(r => r.success).length
        const failureCount = results.filter(r => !r.success).length

        return JSON.stringify({
          ok: true,
          schemaName,
          collections: results,
          totalEntities,
          summary: {
            total: results.length,
            succeeded: successCount,
            failed: failureCount
          },
          message: `Loaded ${totalEntities} entities across ${successCount} collections`
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "LOAD_ALL_ERROR",
            message: error.message || "Failed to load collections"
          }
        })
      }
    }
  })
}
