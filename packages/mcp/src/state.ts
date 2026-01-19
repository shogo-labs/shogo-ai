import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { isS3Enabled } from "@shogo/state-api"
import type { MCPContext } from '@shogo/state-api/mcp-isolation/types'

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

/**
 * Get the effective project ID for project-scoped operations.
 *
 * Project isolation extends workspace isolation by adding a project layer:
 * - S3 mode: Returns project ID for S3 key prefixing within workspace
 * - Filesystem mode: Returns path to project-specific schema directory
 *
 * The PROJECT_ID environment variable takes precedence, indicating this
 * MCP instance is running in project context (not platform context).
 *
 * @param projectId - Optional project ID override
 * @returns Project ID or 'default' if not in project context
 */
export function getEffectiveProject(projectId?: string): string {
  // Explicit parameter takes precedence
  if (projectId && projectId !== 'default') {
    return projectId
  }

  // Check environment variable (set by Knative/Docker for project MCP instances)
  if (process.env.PROJECT_ID) {
    return process.env.PROJECT_ID
  }

  // Default: not in project context
  return 'default'
}

/**
 * Check if running in project context (vs platform context).
 *
 * Project context is indicated by PROJECT_ID environment variable,
 * which is set when running as a per-project MCP instance (Knative Service).
 *
 * @returns true if PROJECT_ID env var is set
 */
export function isProjectContext(): boolean {
  return !!process.env.PROJECT_ID
}

/**
 * Get the current MCP context based on environment.
 *
 * The MCP context determines which tools are available:
 * - 'platform': Full tool access (all 16 tools, all schemas)
 * - 'project': Restricted tool access (10 tools, user workspace only)
 *
 * Context is determined by:
 * 1. MCP_CONTEXT env var (explicit override)
 * 2. PROJECT_ID env var presence (implies project context)
 * 3. Default: platform context
 *
 * @returns 'platform' or 'project'
 */
export function getMCPContext(): MCPContext {
  // Explicit context override
  const explicitContext = process.env.MCP_CONTEXT
  if (explicitContext === 'platform' || explicitContext === 'project') {
    return explicitContext
  }

  // PROJECT_ID implies project context
  if (process.env.PROJECT_ID) {
    return 'project'
  }

  // Default: platform context
  return 'platform'
}

/**
 * Get the full path for project-scoped schema storage.
 *
 * Combines workspace and project IDs for hierarchical isolation:
 * - S3 mode: Returns key prefix like "workspace-id/project-id"
 * - Filesystem mode: Returns path like "/path/.schemas/workspace/project-id"
 *
 * @param projectId - Optional project ID override
 * @returns Full path/prefix for project schemas
 */
export function getProjectSchemaPath(projectId?: string): string {
  const workspace = getEffectiveWorkspace()
  const project = getEffectiveProject(projectId)

  if (isS3Enabled()) {
    // S3 mode: combine as key prefix
    return project === 'default' ? workspace : `${workspace}/${project}`
  }

  // Filesystem mode: combine as directory path
  return project === 'default' ? workspace : resolve(workspace, project)
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
