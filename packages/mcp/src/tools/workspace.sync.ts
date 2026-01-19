/**
 * workspace.sync MCP Tool
 *
 * Syncs workspace data (SQLite database) to S3.
 * Call this after making changes to persist data to cloud storage.
 *
 * When S3 mode is enabled:
 * - Downloads SQLite from S3 on first access (automatic)
 * - Writes go to local SQLite file (automatic)
 * - This tool uploads the SQLite file back to S3 (explicit)
 *
 * @module tools/workspace.sync
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { isS3Enabled } from "@shogo/state-api"
// Server-only module - import directly
import { S3SqliteManager } from "@shogo/state-api/persistence/s3-sqlite"

const Params = t({
  workspace: "string",
  "force?": "boolean"
})

export function registerWorkspaceSync(server: FastMCP) {
  server.addTool({
    name: "workspace.sync",
    description: "Sync workspace data to S3. Call after making changes to persist to cloud storage.",
    parameters: Params,
    execute: async (args: any) => {
      const { workspace, force } = args as { workspace: string; force?: boolean }

      if (!isS3Enabled()) {
        return JSON.stringify({
          ok: true,
          synced: false,
          message: "S3 storage not enabled - data is stored locally"
        })
      }

      try {
        const synced = await S3SqliteManager.sync(workspace, force ?? false)

        return JSON.stringify({
          ok: true,
          synced,
          message: synced
            ? `Workspace '${workspace}' data synced to S3`
            : `Workspace '${workspace}' has no changes to sync`
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "SYNC_ERROR",
            message: error.message || "Failed to sync workspace data"
          }
        })
      }
    }
  })
}
