import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { isS3Enabled } from "@shogo/state-api"

// Compute monorepo root from this file's location
// This file is at: packages/mcp/src/state.ts
// Monorepo root is 3 levels up
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const MONOREPO_ROOT = resolve(__dirname, '../../../')

/**
 * Get the effective workspace location for schema operations.
 *
 * - S3 mode: Returns workspace ID (e.g., "workspace") for S3 key prefixing
 * - Filesystem mode: Returns absolute path to .schemas directory
 *
 * @param workspace - Optional workspace override
 * @returns Workspace ID (S3) or absolute path (filesystem)
 */
export function getEffectiveWorkspace(workspace?: string): string {
  // S3 mode: return workspace ID (default from env or 'workspace')
  if (isS3Enabled()) {
    if (!workspace || workspace === 'workspace') {
      return process.env.WORKSPACE_ID || 'workspace'
    }
    return workspace
  }

  // Filesystem mode: return absolute path
  if (!workspace || workspace === 'workspace') {
    // Use SCHEMAS_PATH env var if set (Docker), otherwise default to monorepo .schemas
    return process.env.SCHEMAS_PATH || resolve(MONOREPO_ROOT, '.schemas')
  }
  return workspace
}

export type RefKind = "single" | "array"

export interface ModelField {
  name: string
  type: string
  required: boolean
  computed?: boolean
}

export interface ModelRef {
  field: string
  target: string
  kind: RefKind
}

export interface ModelDescriptor {
  name: string
  collectionName: string
  fields: ModelField[]
  refs?: ModelRef[]
}
