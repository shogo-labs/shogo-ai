import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getMetaStore } from "@shogo/state-api"
import { getRuntimeStore } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

const Params = t({
  schema: "string",
  model: "string",
  "filter?": "object",
  "workspace?": "string"
})

/**
 * Load a single collection's data from disk into the runtime store.
 *
 * This tool:
 * 1. Finds the collection in the cached runtime store
 * 2. Calls collection.loadAll() which uses the CollectionPersistable mixin
 * 3. Returns count of loaded entities
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
 * // Then load specific collection data
 * await data.load({ schema: "my-schema", model: "Task", workspace: "/path/to/workspace" })
 * ```
 */
export function registerDataLoad(server: FastMCP) {
  server.addTool({
    name: "data.load",
    description: "Load a single collection's data from disk into the runtime store",
    parameters: Params,
    execute: async (args: any) => {
      const { schema, model, filter, workspace } = args as { schema: string; model: string; filter?: Record<string, any>; workspace?: string }

      // If no workspace provided, use monorepo's .schemas directory
      const effectiveWorkspace = getEffectiveWorkspace(workspace)

      try {
        // 1. Find schema in meta-store
        const metaStore = getMetaStore()
        const schemaEntity = metaStore.findSchemaByName(schema)

        if (!schemaEntity) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "SCHEMA_NOT_FOUND",
              message: `Schema '${schema}' not found. Did you call schema.load first?`
            }
          })
        }

        // 2. Find model within schema
        const modelEntity = schemaEntity.models.find((m: any) => m.name === model)

        if (!modelEntity) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "MODEL_NOT_FOUND",
              message: `Model '${model}' not found in schema '${schema}'. Did you call schema.load first?`
            }
          })
        }

        // 3. Get runtime store from cache
        const runtimeStore = getRuntimeStore(schemaEntity.id, effectiveWorkspace)
        if (!runtimeStore) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "RUNTIME_STORE_NOT_FOUND",
              message: `Runtime store not found for schema ${schemaEntity.id}. Did you call schema.load first?`
            }
          })
        }

        // 4. Access collection
        const collectionName = modelEntity.collectionName
        const collection = runtimeStore[collectionName]
        if (!collection) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "COLLECTION_NOT_FOUND",
              message: `Collection '${collectionName}' not found in runtime store`
            }
          })
        }

        // 5. Verify collection has loadAll method (should be added by CollectionPersistable mixin)
        if (typeof collection.loadAll !== 'function') {
          return JSON.stringify({
            ok: false,
            error: {
              code: "MIXIN_NOT_FOUND",
              message: `Collection '${collectionName}' does not have loadAll method. CollectionPersistable mixin may not be applied.`
            }
          })
        }

        // 6. Load data using CollectionPersistable mixin
        // Pass filter for partition pushdown optimization
        await collection.loadAll(filter)

        // 7. Get loaded count
        const count = collection.all().length

        return JSON.stringify({
          ok: true,
          model,
          collectionName,
          count,
          message: count > 0
            ? `Loaded ${count} entities into ${collectionName}`
            : `No persisted data found for ${collectionName} (empty collection)`
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "LOAD_ERROR",
            message: error.message || "Failed to load collection data"
          }
        })
      }
    }
  })
}
