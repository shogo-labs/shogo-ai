/**
 * Schema save/load operations
 *
 * Includes version tracking and history snapshots for schema migrations.
 * Supports both filesystem and S3 backends via SCHEMA_STORAGE env var.
 *
 * Backend selection:
 * - SCHEMA_STORAGE=s3: Use S3 (requires S3_SCHEMA_BUCKET, AWS_REGION)
 * - SCHEMA_STORAGE=filesystem or unset: Use local filesystem (default)
 */

import { ensureDir, readJson, writeJson, exists, listDirs } from './io'
import { isS3Enabled } from './s3-io'
import * as s3Schema from './s3-schema-io'
import * as fs from 'fs/promises'
import * as path from 'path'

// ============================================================================
// Types
// ============================================================================

/**
 * Schema snapshot representing a specific version of a schema.
 */
export interface SchemaSnapshot {
  /** Version number of this snapshot */
  version: number
  /** The schema content at this version */
  schema: any
  /** Timestamp when this version was created */
  createdAt: number
}

/**
 * Saves a schema to storage (filesystem or S3 based on SCHEMA_STORAGE env)
 *
 * Version tracking:
 * - First save: version starts at 1
 * - Subsequent saves: version auto-increments
 * - Before overwriting: current version is saved to history/v{N}.json
 *
 * @param schema - Meta-store Schema entity with id, name, toEnhancedJson()
 * @param templates - Optional map of template name to template content
 * @param workspace - Optional workspace identifier (path for filesystem, workspace ID for S3)
 * @returns The path/key where the schema was saved
 */
export async function saveSchema(schema: any, templates?: Record<string, string>, workspace?: string): Promise<string> {
  // Delegate to S3 if enabled
  if (isS3Enabled()) {
    return s3Schema.saveSchemaToS3(schema, templates, workspace)
  }

  // Validate workspace if provided (filesystem mode)
  if (workspace) {
    if (!path.isAbsolute(workspace)) {
      throw new Error(`Workspace must be absolute path: ${workspace}`)
    }
    if (!await exists(workspace)) {
      throw new Error(`Workspace directory does not exist: ${workspace}`)
    }
  }

  // Determine base directory
  const baseDir = workspace || '.schemas'
  const dir = `${baseDir}/${schema.name}`
  await ensureDir(dir)

  // Ensure templates directory exists
  await ensureDir(`${dir}/templates`)

  // Write template files if provided
  if (templates) {
    for (const [name, content] of Object.entries(templates)) {
      await fs.writeFile(`${dir}/templates/${name}`, content, 'utf-8')
    }
  }

  // Get current version (0 if schema doesn't exist)
  const currentVersion = await getSchemaVersion(schema.name, workspace)

  // If there's an existing schema, create a history snapshot before overwriting
  if (currentVersion > 0) {
    const historyDir = `${dir}/history`
    await ensureDir(historyDir)

    // Read current schema and save as snapshot
    try {
      const currentSchema = await readJson(`${dir}/schema.json`)
      await writeJson(`${historyDir}/v${currentVersion}.json`, currentSchema)
    } catch (error) {
      console.error(`Failed to create history snapshot for version ${currentVersion}:`, error)
      // Continue with save operation even if history snapshot fails
    }
  }

  // Calculate new version
  const newVersion = currentVersion + 1

  const enhanced = schema.toEnhancedJson
  const schemaFile = {
    id: schema.id,
    name: schema.name,
    format: schema.format,
    createdAt: schema.createdAt,
    version: newVersion,  // Add version field
    ...enhanced,  // Merges $defs, $schema
    ...(schema.viewsMetadata && { views: schema.viewsMetadata })  // Add views if present
  }

  await writeJson(`${dir}/schema.json`, schemaFile)

  return dir
}

/**
 * Loads a schema from storage (filesystem or S3 based on SCHEMA_STORAGE env)
 *
 * @param name - Schema name (folder name)
 * @param workspace - Optional workspace identifier (path for filesystem, workspace ID for S3)
 * @returns Metadata (including version) and enhanced JSON schema
 */
export async function loadSchema(name: string, workspace?: string): Promise<{
  metadata: { id: string; name: string; createdAt: number; format: string; version?: number; views?: Record<string, any> }
  enhanced: any
}> {
  // Delegate to S3 if enabled
  if (isS3Enabled()) {
    return s3Schema.loadSchemaFromS3(name, workspace)
  }

  // Filesystem mode
  const baseDir = workspace || '.schemas'
  const filePath = `${baseDir}/${name}/schema.json`

  if (!await exists(filePath)) {
    const error: any = new Error(`Schema file not found: ${filePath}`)
    error.code = 'ENOENT'
    throw error
  }

  const data = await readJson(filePath)

  const { id, name: schemaName, createdAt, format, version, views, ...enhanced } = data
  return {
    metadata: {
      id,
      name: schemaName,
      createdAt,
      format,
      ...(version !== undefined && { version }),
      ...(views && { views })
    },
    enhanced
  }
}

/**
 * Lists all saved schemas
 *
 * @param workspace - Optional workspace identifier (path for filesystem, workspace ID for S3)
 * @returns Array of schema metadata
 */
export async function listSchemas(workspace?: string): Promise<Array<{
  name: string
  id: string
  createdAt: number
  path: string
}>> {
  // Delegate to S3 if enabled
  if (isS3Enabled()) {
    return s3Schema.listSchemasInS3(workspace)
  }

  // Filesystem mode
  const baseDir = workspace || '.schemas'
  if (!await exists(baseDir)) return []

  const dirs = await listDirs(baseDir)
  const schemas = []

  for (const name of dirs) {
    try {
      const data = await readJson(`${baseDir}/${name}/schema.json`)
      schemas.push({
        name: data.name,
        id: data.id,
        createdAt: data.createdAt,
        path: `${baseDir}/${name}`
      })
    } catch {
      // Skip invalid schemas (missing or malformed schema.json)
    }
  }

  return schemas
}

// ============================================================================
// Schema Versioning Functions
// ============================================================================

/**
 * Gets the current version of a schema.
 *
 * @param name - Schema name
 * @param workspace - Optional workspace directory (defaults to .schemas)
 * @returns Current version number, or 0 if schema doesn't exist
 */
export async function getSchemaVersion(name: string, workspace?: string): Promise<number> {
  const baseDir = workspace || '.schemas'
  const filePath = `${baseDir}/${name}/schema.json`

  if (!await exists(filePath)) {
    return 0
  }

  try {
    const data = await readJson(filePath)
    return data.version || 0
  } catch {
    return 0
  }
}

/**
 * Saves a schema snapshot for a specific version.
 * Used by the orchestrator to record schema state at migration time.
 *
 * @param name - Schema name
 * @param version - Version number
 * @param schema - The schema content to save
 * @param workspace - Optional workspace directory (defaults to .schemas)
 */
export async function saveSchemaSnapshot(
  name: string,
  version: number,
  schema: any,
  workspace?: string
): Promise<void> {
  const baseDir = workspace || '.schemas'
  const dir = `${baseDir}/${name}`
  const historyDir = `${dir}/history`

  await ensureDir(historyDir)
  await writeJson(`${historyDir}/v${version}.json`, schema)
}

/**
 * Gets a specific historical version of a schema.
 *
 * @param name - Schema name
 * @param version - Version number to retrieve
 * @param workspace - Optional workspace directory (defaults to .schemas)
 * @returns SchemaSnapshot containing the schema at the requested version
 * @throws Error if the requested version is not found
 */
export async function getSchemaSnapshot(name: string, version: number, workspace?: string): Promise<SchemaSnapshot> {
  const baseDir = workspace || '.schemas'
  const dir = `${baseDir}/${name}`

  // Check if this is the current version
  const currentVersion = await getSchemaVersion(name, workspace)

  if (version === currentVersion) {
    // Return current schema
    const data = await readJson(`${dir}/schema.json`)
    const { id, name: schemaName, createdAt, format, version: v, views, ...schema } = data
    return {
      version: v,
      schema: { $defs: schema.$defs, $schema: schema.$schema, ...schema },
      createdAt,
    }
  }

  // Look in history
  const historyPath = `${dir}/history/v${version}.json`

  if (!await exists(historyPath)) {
    throw new Error(`Schema version ${version} not found for '${name}'`)
  }

  const data = await readJson(historyPath)
  const { id, name: schemaName, createdAt, format, version: v, views, ...schema } = data

  return {
    version: v,
    schema: { $defs: schema.$defs, $schema: schema.$schema, ...schema },
    createdAt,
  }
}

/**
 * Lists all available versions of a schema.
 *
 * @param name - Schema name
 * @param workspace - Optional workspace directory (defaults to .schemas)
 * @returns Array of version numbers, sorted ascending
 */
export async function listSchemaVersions(name: string, workspace?: string): Promise<number[]> {
  const baseDir = workspace || '.schemas'
  const dir = `${baseDir}/${name}`

  // Check if schema exists
  if (!await exists(`${dir}/schema.json`)) {
    return []
  }

  const versions: number[] = []

  // Get current version
  const currentVersion = await getSchemaVersion(name, workspace)
  if (currentVersion > 0) {
    versions.push(currentVersion)
  }

  // Get historical versions
  const historyDir = `${dir}/history`
  if (await exists(historyDir)) {
    try {
      const files = await fs.readdir(historyDir)
      for (const file of files) {
        const match = file.match(/^v(\d+)\.json$/)
        if (match) {
          versions.push(parseInt(match[1], 10))
        }
      }
    } catch {
      // History directory might not exist or be unreadable
    }
  }

  // Sort ascending and deduplicate
  return [...new Set(versions)].sort((a, b) => a - b)
}
