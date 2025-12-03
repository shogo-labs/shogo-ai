import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// Compute monorepo root from this file's location
// This file is at: packages/mcp/src/state.ts
// Monorepo root is 3 levels up
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const MONOREPO_ROOT = resolve(__dirname, '../../../')

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
