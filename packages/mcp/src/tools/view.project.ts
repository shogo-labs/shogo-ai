import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { executeView } from "@shogo/state-api"
import * as fs from "fs/promises"
import * as path from "path"

const Params = t({
  schema: "string",
  view: "string",
  output_path: "string",
  "params?": "unknown",
  "ensure_directory?": "boolean"
})

export function registerViewProject(server: FastMCP) {
  server.addTool({
    name: "view.project",
    description: "Execute a view and project (write) the result to a file on disk",
    parameters: Params,
    execute: async (args: any) => {
      const {
        schema,
        view,
        output_path,
        params = {},
        ensure_directory = true
      } = args as {
        schema: string
        view: string
        output_path: string
        params?: Record<string, any>
        ensure_directory?: boolean
      }

      try {
        // 1. Execute view (query or template)
        const result = await executeView(schema, view, params)

        // 2. Determine content format
        const isTemplate = typeof result === "string"
        const content = isTemplate ? result : JSON.stringify(result, null, 2)

        // 3. Ensure parent directory exists (unless disabled)
        if (ensure_directory) {
          const dir = path.dirname(output_path)
          await fs.mkdir(dir, { recursive: true })
        }

        // 4. Write to disk
        await fs.writeFile(output_path, content, 'utf-8')

        // 5. Calculate stats
        const stats = await fs.stat(output_path)

        return JSON.stringify({
          ok: true,
          view: {
            schema,
            name: view,
            type: isTemplate ? "template" : "query"
          },
          projection: {
            output_path,
            bytes_written: stats.size,
            format: isTemplate ? "text" : "json",
            preview: content.slice(0, 200)  // First 200 chars for validation
          },
          metadata: {
            timestamp: Date.now(),
            ...(Array.isArray(result) && { entity_count: result.length })
          }
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: error.code || "VIEW_PROJECTION_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
            output_path
          }
        })
      }
    },
  })
}
