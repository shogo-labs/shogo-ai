import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getMetaStore } from "@shogo/state-api"
import { saveSchema } from "@shogo/state-api"

const Params = t({
  schema: "string",
  name: "string"
})

export function registerViewDelete(server: FastMCP) {
  server.addTool({
    name: "view.delete",
    description: "Remove a view definition from a schema",
    parameters: Params,
    execute: async (args: any) => {
      const { schema: schemaName, name } = args as {
        schema: string
        name: string
      }

      try {
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

        // Find the view
        const view = schema.views.find((v: any) => v.name === name)

        if (!view) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "VIEW_NOT_FOUND",
              message: `View '${name}' not found in schema '${schemaName}'`
            }
          })
        }

        // Remove the view
        metaStore.viewDefinitionCollection.remove(view.id)

        // Save schema to disk
        await saveSchema(schema)

        return JSON.stringify({
          ok: true,
          view: {
            id: view.id,
            schema: schemaName,
            name
          },
          operation: "deleted"
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "VIEW_DELETE_ERROR",
            message: error instanceof Error ? error.message : "Unknown error"
          }
        })
      }
    },
  })
}
