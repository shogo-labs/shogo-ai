import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getSnapshot } from "mobx-state-tree"
import { getMetaStore } from "@shogo/state-api"
import { getRuntimeStore } from "@shogo/state-api"

const Params = t({
  schema: "string",
  model: "string",
  id: "string",
  "workspace?": "string"
})

export function registerStoreGet(server: FastMCP) {
  server.addTool({
    name: "store.get",
    description: "Retrieve an entity instance by ID",
    parameters: Params,
    execute: async (args: any) => {
      const { schema, model, id, workspace } = args as { schema: string; model: string; id: string; workspace?: string }

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
        const runtimeStore = getRuntimeStore(schemaEntity.id, workspace)
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

        // 5. Get instance (pure read from cached runtime store)
        const instance = collection.get(id)
        if (!instance) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Entity with id '${id}' not found in model '${model}'. If data hasn't been loaded, use data.load first.`
            }
          })
        }

        return JSON.stringify({
          ok: true,
          data: getSnapshot(instance)
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: error.message || "Failed to retrieve instance"
          }
        })
      }
    }
  })
}
