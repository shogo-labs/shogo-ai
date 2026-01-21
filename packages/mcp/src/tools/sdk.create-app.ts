/**
 * MCP Tool: sdk.createApp
 *
 * Scaffold a complete app from Enhanced JSON Schema.
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { scaffoldApp } from "@shogo/state-api/generators"
import type { EnhancedJsonSchema } from "@shogo/state-api"

// Parameter schema
const Params = t({
  /** Project name */
  name: "string",
  /** Schema as JSON string or object */
  schema: "string | object",
  /** Output directory (optional, defaults to workspaces/{name}) */
  "output?": "string",
  /** Features to include */
  "features?": {
    "api?": "boolean",
    "styling?": "boolean",
  },
  /** Skip dependency installation */
  "skipInstall?": "boolean",
  /** Dry run - return file contents without writing */
  "dryRun?": "boolean",
})

type SdkCreateAppParams = typeof Params.infer

/**
 * Execute sdk.createApp
 */
export async function executeSdkCreateApp(
  args: SdkCreateAppParams
): Promise<{ ok: boolean; projectDir?: string; files?: string[]; fileContents?: Record<string, string>; error?: any }> {
  try {
    // Parse schema if string
    let schema: EnhancedJsonSchema | string
    if (typeof args.schema === "string") {
      // Could be JSON string or file path
      if (args.schema.trim().startsWith("{")) {
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
        // Treat as file path
        schema = args.schema
      }
    } else {
      schema = args.schema as EnhancedJsonSchema
    }

    // Scaffold app
    const result = await scaffoldApp({
      name: args.name,
      schema,
      output: args.output,
      features: args.features,
      skipInstall: args.skipInstall,
      dryRun: args.dryRun,
    })

    return {
      ok: true,
      projectDir: result.projectDir,
      files: result.files,
      fileContents: result.fileContents,
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "SCAFFOLD_ERROR",
        message: error.message || "Failed to scaffold app",
      },
    }
  }
}

/**
 * Register sdk.createApp tool
 */
export function registerSdkCreateApp(server: FastMCP) {
  server.addTool({
    name: "sdk.createApp",
    description:
      "Scaffold a complete app from Enhanced JSON Schema. Creates project directory with domain.ts, routes.ts, App.tsx, and installs dependencies.",
    parameters: Params as any,
    execute: async (args: any) => {
      const result = await executeSdkCreateApp(args)
      return JSON.stringify(result, null, 2)
    },
  })
}
