/**
 * S3-based schema save/load operations
 *
 * Mirrors schema-io.ts interface but stores schemas in S3 instead of filesystem.
 * Includes version tracking and history snapshots for schema migrations.
 *
 * S3 Key Structure:
 * {prefix}/{workspace}/{schemaName}/schema.json       - Current schema
 * {prefix}/{workspace}/{schemaName}/history/v{N}.json - Version snapshots
 * {prefix}/{workspace}/{schemaName}/templates/{name}  - Template files
 *
 * @example
 * // With S3_SCHEMA_PREFIX="schemas/" and workspace="workspace-123":
 * // schemas/workspace-123/my-app/schema.json
 * // schemas/workspace-123/my-app/history/v1.json
 */

import {
  buildS3Key,
  readJsonFromS3,
  writeJsonToS3,
  existsInS3,
  listDirsInS3,
  getS3Client,
  getS3Bucket,
} from './s3-io'
import { PutObjectCommand } from '@aws-sdk/client-s3'

// ============================================================================
// Types
// ============================================================================

export interface S3SchemaSnapshot {
  version: number
  schema: any
  createdAt: number
}

// ============================================================================
// Schema Operations
// ============================================================================

/**
 * Saves a schema to S3 at {prefix}/{workspace}/{schemaName}/schema.json
 *
 * Version tracking:
 * - First save: version starts at 1
 * - Subsequent saves: version auto-increments
 * - Before overwriting: current version is saved to history/v{N}.json
 *
 * @param schema - Meta-store Schema entity with id, name, toEnhancedJson()
 * @param templates - Optional map of template name to template content
 * @param workspace - Workspace identifier (required for S3)
 * @returns The S3 key where the schema was saved
 */
export async function saveSchemaToS3(
  schema: any,
  templates?: Record<string, string>,
  workspace?: string
): Promise<string> {
  console.log('[s3-schema-io] saveSchemaToS3 called:', { name: schema?.name, workspace })
  
  if (!workspace) {
    throw new Error('Workspace is required for S3 schema storage')
  }

  const schemaKey = buildS3Key(workspace, schema.name, 'schema.json')
  console.log('[s3-schema-io] Built S3 key:', schemaKey)

  // Write template files if provided
  if (templates) {
    const client = getS3Client()
    const bucket = getS3Bucket()

    for (const [name, content] of Object.entries(templates)) {
      const templateKey = buildS3Key(workspace, schema.name, 'templates', name)
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: templateKey,
        Body: content,
        ContentType: 'text/plain',
      }))
    }
  }

  // Get current version (0 if schema doesn't exist)
  const currentVersion = await getS3SchemaVersion(schema.name, workspace)

  // If there's an existing schema, create a history snapshot before overwriting
  if (currentVersion > 0) {
    try {
      const currentSchema = await readJsonFromS3(schemaKey)
      const historyKey = buildS3Key(workspace, schema.name, 'history', `v${currentVersion}.json`)
      await writeJsonToS3(historyKey, currentSchema)
    } catch (error) {
      console.error(`Failed to create S3 history snapshot for version ${currentVersion}:`, error)
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
    version: newVersion,
    ...enhanced,
    ...(schema.viewsMetadata && { views: schema.viewsMetadata }),
  }

  console.log('[s3-schema-io] Writing schema to S3:', schemaKey)
  await writeJsonToS3(schemaKey, schemaFile)
  console.log('[s3-schema-io] ✅ Schema saved to S3:', schemaKey)

  return schemaKey
}

/**
 * Loads a schema from S3
 *
 * @param name - Schema name (folder name)
 * @param workspace - Workspace identifier (required for S3)
 * @returns Metadata (including version) and enhanced JSON schema
 */
export async function loadSchemaFromS3(
  name: string,
  workspace?: string
): Promise<{
  metadata: { id: string; name: string; createdAt: number; format: string; version?: number; views?: Record<string, any> }
  enhanced: any
}> {
  if (!workspace) {
    throw new Error('Workspace is required for S3 schema storage')
  }

  const schemaKey = buildS3Key(workspace, name, 'schema.json')

  if (!await existsInS3(schemaKey)) {
    const error: any = new Error(`Schema file not found in S3: ${schemaKey}`)
    error.code = 'ENOENT'
    throw error
  }

  const data = await readJsonFromS3(schemaKey)

  const { id, name: schemaName, createdAt, format, version, views, ...enhanced } = data
  return {
    metadata: {
      id,
      name: schemaName,
      createdAt,
      format,
      ...(version !== undefined && { version }),
      ...(views && { views }),
    },
    enhanced,
  }
}

/**
 * Lists all saved schemas in S3 for a workspace
 *
 * @param workspace - Workspace identifier
 * @returns Array of schema metadata
 */
export async function listSchemasInS3(workspace?: string): Promise<Array<{
  name: string
  id: string
  createdAt: number
  path: string
}>> {
  if (!workspace) {
    throw new Error('Workspace is required for S3 schema storage')
  }

  const prefix = buildS3Key(workspace) + '/'
  const dirs = await listDirsInS3(prefix)
  const schemas = []

  for (const name of dirs) {
    try {
      const schemaKey = buildS3Key(workspace, name, 'schema.json')
      const data = await readJsonFromS3(schemaKey)
      schemas.push({
        name: data.name,
        id: data.id,
        createdAt: data.createdAt,
        path: schemaKey,
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
 * Gets the current version of a schema in S3.
 *
 * @param name - Schema name
 * @param workspace - Workspace identifier
 * @returns Current version number, or 0 if schema doesn't exist
 */
export async function getS3SchemaVersion(name: string, workspace?: string): Promise<number> {
  if (!workspace) {
    return 0
  }

  const schemaKey = buildS3Key(workspace, name, 'schema.json')

  if (!await existsInS3(schemaKey)) {
    return 0
  }

  try {
    const data = await readJsonFromS3(schemaKey)
    return data.version || 0
  } catch {
    return 0
  }
}

/**
 * Gets a specific historical version of a schema from S3.
 */
export async function getS3SchemaSnapshot(
  name: string,
  version: number,
  workspace?: string
): Promise<S3SchemaSnapshot> {
  if (!workspace) {
    throw new Error('Workspace is required for S3 schema storage')
  }

  const currentVersion = await getS3SchemaVersion(name, workspace)

  if (version === currentVersion) {
    const schemaKey = buildS3Key(workspace, name, 'schema.json')
    const data = await readJsonFromS3(schemaKey)
    const { id, name: schemaName, createdAt, format, version: v, views, ...schema } = data
    return {
      version: v,
      schema: { $defs: schema.$defs, $schema: schema.$schema, ...schema },
      createdAt,
    }
  }

  const historyKey = buildS3Key(workspace, name, 'history', `v${version}.json`)

  if (!await existsInS3(historyKey)) {
    throw new Error(`Schema version ${version} not found for '${name}'`)
  }

  const data = await readJsonFromS3(historyKey)
  const { id, name: schemaName, createdAt, format, version: v, views, ...schema } = data

  return {
    version: v,
    schema: { $defs: schema.$defs, $schema: schema.$schema, ...schema },
    createdAt,
  }
}
