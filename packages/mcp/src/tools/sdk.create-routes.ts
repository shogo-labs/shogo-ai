/**
 * MCP Tool: sdk.createRoutes
 *
 * Generate Hono CRUD routes from Enhanced JSON Schema.
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { createRoutes } from "@shogo/state-api/generators"
import type { EnhancedJsonSchema } from "@shogo/state-api"

// Parameter schema
const Params = t({
  /** Schema as JSON string or object */
  schema: "string | object",
  /** Which entities to generate routes for (default: all) */
  "entities?": "string[]",
  /** Base path prefix (default: '/api') */
  "basePath?": "string",
})

type SdkCreateRoutesParams = typeof Params.infer

/**
 * Execute sdk.createRoutes
 */
export async function executeSdkCreateRoutes(
  args: SdkCreateRoutesParams
): Promise<{ ok: boolean; code?: string; entities?: string[]; error?: any }> {
  try {
    // Parse schema if string
    let schema: EnhancedJsonSchema
    if (typeof args.schema === "string") {
      try {
        schema = JSON.parse(args.schema)
      } catch {
        return {
          ok: false,
          error: {
            code: "INVALID_JSON",
            message: "Failed to parse schema JSON string",
          },
        }
      }
    } else {
      schema = args.schema as EnhancedJsonSchema
    }

    // Generate routes
    const result = createRoutes({
      schema,
      entities: args.entities,
      basePath: args.basePath || "/api",
    })

    return {
      ok: true,
      code: result.code,
      entities: result.entities,
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "GENERATION_ERROR",
        message: error.message || "Failed to generate routes",
      },
    }
  }
}

/**
 * Register sdk.createRoutes tool
 */
export function registerSdkCreateRoutes(server: FastMCP) {
  server.addTool({
    name: "sdk.createRoutes",
    description:
      "Generate Hono CRUD routes from Enhanced JSON Schema. Returns TypeScript code with GET, POST, PATCH, DELETE endpoints for each entity.",
    parameters: Params as any,
    execute: async (args: any) => {
      const result = await executeSdkCreateRoutes(args)
      return JSON.stringify(result, null, 2)
    },
  })
}
