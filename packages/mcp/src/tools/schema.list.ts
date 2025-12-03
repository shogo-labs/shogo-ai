import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { listSchemas } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

export function registerSchemaList(server: FastMCP) {
  server.addTool({
    name: "schema.list",
    description: "List all saved schemas",
    parameters: t({}),
    execute: async () => {
      // Use monorepo's .schemas directory
      const effectiveWorkspace = getEffectiveWorkspace()

      try {
        const schemas = await listSchemas(effectiveWorkspace)
        return JSON.stringify({
          ok: true,
          schemas
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: 'LIST_ERROR',
            message: error.message || 'Failed to list schemas'
          }
        })
      }
    }
  })
}
