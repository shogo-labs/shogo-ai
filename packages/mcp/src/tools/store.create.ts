import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getSnapshot } from "mobx-state-tree"
import { getMetaStore } from "@shogo/state-api"
import { getRuntimeStore } from "@shogo/state-api"

const Params = t({
  schema: "string",
  model: "string",
  data: "object",
  "workspace?": "string"
})

export function registerStoreCreate(server: FastMCP) {
  server.addTool({
    name: "store.create",
    description: "Create a new entity instance in the specified model",
    parameters: Params,
    execute: async (args: any) => {
      const { schema, model, data, workspace } = args as { schema: string; model: string; data: unknown; workspace?: string }

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

        // 5. Create instance (MST validates automatically)
        const instance = collection.add(data)

        // 6. Auto-save collection to disk using CollectionPersistable mixin
        await collection.saveAll()

        return JSON.stringify({
          ok: true,
          id: instance.id,
          data: getSnapshot(instance)
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: error.message || "Failed to create instance"
          }
        })
      }
    }
  })
}
