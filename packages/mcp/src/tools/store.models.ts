import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getMetaStore } from "@shogo/state-api"

const Params = t({ schemaName: "string" })

export function registerStoreModels(server: FastMCP) {
  server.addTool({
    name: "store.models",
    description: "List model descriptors for a schema",
    parameters: Params,
    execute: async (args: any) => {
      const { schemaName } = args as { schemaName: string }

      const metaStore = getMetaStore()
      const schema = metaStore.findSchemaByName(schemaName)

      if (!schema) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "SCHEMA_NOT_FOUND",
            message: `Schema '${schemaName}' not found`
          }
        })
      }

      return JSON.stringify({
        ok: true,
        models: schema.toModelDescriptors
      })
    },
  })
}
