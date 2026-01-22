/**
 * Path constants for the MCP package.
 * 
 * This file has no external dependencies and can be safely imported
 * by template tools that don't need the full state-api.
 */
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// Compute monorepo root from this file's location
// This file is at: packages/mcp/src/paths.ts
// Monorepo root is 3 levels up
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const MONOREPO_ROOT = resolve(__dirname, '../../../')
