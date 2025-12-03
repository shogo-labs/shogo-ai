import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { executeView } from "@shogo/state-api"

const Params = t({
  schema: "string",
  view: "string",
  "params?": "unknown"  // Record<string, any>
})

export function registerViewExecute(server: FastMCP) {
  server.addTool({
    name: "view.execute",
    description: "Execute a named view (query or template)",
    parameters: Params,
    execute: async (args: any) => {
      const { schema, view, params } = args as {
        schema: string
        view: string
        params?: Record<string, any>
      }

      try {
        const result = await executeView(schema, view, params || {})

        // Determine result type based on whether it's a string (template) or array (query)
        const isTemplate = typeof result === "string"

        return JSON.stringify({
          ok: true,
          view: {
            schema,
            name: view,
            type: isTemplate ? "template" : "query"
          },
          result,
          metadata: {
            resultType: isTemplate ? "string" : "array",
            ...(Array.isArray(result) && { count: result.length })
          }
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "VIEW_EXECUTION_ERROR",
            message: error instanceof Error ? error.message : "Unknown error"
          }
        })
      }
    },
  })
}
