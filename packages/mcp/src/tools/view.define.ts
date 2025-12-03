import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getMetaStore } from "@shogo/state-api"
import { saveSchema } from "@shogo/state-api"
import { v4 as uuidv4 } from "uuid"

const Params = t({
  schema: "string",
  name: "string",
  definition: {
    type: "'query' | 'template'",
    "collection?": "string",
    "filter?": "unknown",
    "select?": "string[]",
    "dataSource?": "string",
    "template?": "string",
  }
})

export function registerViewDefine(server: FastMCP) {
  server.addTool({
    name: "view.define",
    description: "Add or update a view definition in an existing schema",
    parameters: Params,
    execute: async (args: any) => {
      const { schema: schemaName, name, definition } = args as {
        schema: string
        name: string
        definition: {
          type: "query" | "template"
          collection?: string
          filter?: Record<string, any>
          select?: string[]
          dataSource?: string
          template?: string
        }
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

        // Check if view already exists
        const existingView = schema.views.find((v: any) => v.name === name)

        if (existingView) {
          // Remove existing view (update = remove + add)
          metaStore.viewDefinitionCollection.remove(existingView.id)
        }

        // Create new view definition
        const viewDef = metaStore.viewDefinitionCollection.add({
          id: uuidv4(),
          schema: schema.id,
          name,
          type: definition.type,
          ...(definition.collection && { collection: definition.collection }),
          ...(definition.filter && { filter: definition.filter }),
          ...(definition.select && { select: definition.select }),
          ...(definition.dataSource && { dataSource: definition.dataSource }),
          ...(definition.template && { template: definition.template }),
        })

        // Save schema to disk
        await saveSchema(schema)

        return JSON.stringify({
          ok: true,
          view: {
            id: viewDef.id,
            schema: schemaName,
            name,
            type: definition.type
          },
          operation: existingView ? "updated" : "created"
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "VIEW_DEFINE_ERROR",
            message: error instanceof Error ? error.message : "Unknown error"
          }
        })
      }
    },
  })
}
