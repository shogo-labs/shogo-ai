import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getMetaStore } from "@shogo/state-api"

const Params = t({ name: "string" })

export function registerSchemaGet(server: FastMCP) {
  server.addTool({
    name: "schema.get",
    description: "Get a schema by name",
    parameters: Params,
    execute: async (args: any) => {
      const { name } = args as { name: string }

      const metaStore = getMetaStore()
      const schema = metaStore.findSchemaByName(name)

      if (!schema) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "SCHEMA_NOT_FOUND",
            message: `Schema '${name}' not found`
          }
        })
      }

      return JSON.stringify({
        ok: true,
        format: "enhanced-json-schema",
        payload: schema.toEnhancedJson
      })
    },
  })
}
