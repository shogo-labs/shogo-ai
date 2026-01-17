import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// Compute monorepo root from this file's location
// This file is at: packages/mcp/src/state.ts
// Monorepo root is 3 levels up
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const MONOREPO_ROOT = resolve(__dirname, '../../../')

/**
 * Get the effective workspace path, using MONOREPO_ROOT/.schemas as default.
 * This ensures all tools consistently resolve to the same schema storage location.
 *
 * @param workspace - Optional workspace path override. The string 'workspace' is treated as a special value meaning "use default"
 * @returns Absolute path to the .schemas directory
 */
export function getEffectiveWorkspace(workspace?: string): string {
  // Treat 'workspace' as a special identifier meaning "use default"
  // This allows MCPPersistence to pass 'workspace' as a default value
  if (!workspace || workspace === 'workspace') {
    return resolve(MONOREPO_ROOT, '.schemas')
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
