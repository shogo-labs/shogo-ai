import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getSnapshot } from "mobx-state-tree"
import { getMetaStore } from "@shogo/state-api"
import { getRuntimeStore } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

const Params = t({
  schema: "string",
  model: "string",
  "filter?": "object",
  "workspace?": "string"
})

export function registerStoreList(server: FastMCP) {
  server.addTool({
    name: "store.list",
    description: "List all entity instances of a model type, with optional filtering",
    parameters: Params,
    execute: async (args: any) => {
      const { schema, model, filter, workspace } = args as { schema: string; model: string; filter?: unknown; workspace?: string }

      try {
        // 1. Find schema in meta-store
        const metaStore = getMetaStore()
        const schemaEntity = metaStore.findSchemaByName(schema)

        if (!schemaEntity) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "SCHEMA_NOT_FOUND",
              message: `Schema '${schema}' not found`
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
              message: `Model '${model}' not found in schema '${schema}'`
            }
          })
        }

        // 3. Get runtime store from cache (Unit 3: workspace-aware caching)
        const effectiveWorkspace = getEffectiveWorkspace(workspace)
        const runtimeStore = getRuntimeStore(schemaEntity.id, effectiveWorkspace)
        if (!runtimeStore) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "RUNTIME_STORE_NOT_FOUND",
              message: `Runtime store not found for schema ${schemaEntity.id}`
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

        // 5. List all instances (pure read from cached runtime store)
        // Auto-load data from disk if collection is empty
        // This ensures store.list works correctly even if data.load wasn't called
        if (collection.all().length === 0 && typeof collection.loadAll === 'function') {
          await collection.loadAll()
        }
        let instances = collection.all()

        // 6. Apply filter if provided (simple field matching)
        if (filter && typeof filter === "object") {
          instances = instances.filter((instance: any) => {
            return Object.entries(filter).every(([key, value]) => {
              return instance[key] === value
            })
          })
        }

        return JSON.stringify({
          ok: true,
          count: instances.length,
          items: instances.map((instance: any) => getSnapshot(instance))
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: error.message || "Failed to list instances"
          }
        })
      }
    }
  })
}
