/**
 * Schema save/load operations
 */

import { ensureDir, readJson, writeJson, exists, listDirs } from './io'
import * as fs from 'fs/promises'
import * as path from 'path'

/**
 * Saves a schema to disk at .schemas/{schemaName}/schema.json or custom workspace
 *
 * @param schema - Meta-store Schema entity with id, name, toEnhancedJson()
 * @param templates - Optional map of template name to template content
 * @param workspace - Optional absolute path to workspace directory (defaults to .schemas)
 * @returns The directory path where the schema was saved
 */
export async function saveSchema(schema: any, templates?: Record<string, string>, workspace?: string): Promise<string> {
  // Validate workspace if provided
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

  const enhanced = schema.toEnhancedJson
  const schemaFile = {
    id: schema.id,
    name: schema.name,
    format: schema.format,
    createdAt: schema.createdAt,
    ...enhanced,  // Merges $defs, $schema
    ...(schema.viewsMetadata && { views: schema.viewsMetadata })  // Add views if present
  }

  await writeJson(`${dir}/schema.json`, schemaFile)

  return dir
}

/**
 * Loads a schema from disk
 *
 * @param name - Schema name (folder name)
 * @param workspace - Optional absolute path to workspace directory (defaults to .schemas)
 * @returns Metadata and enhanced JSON schema
 */
export async function loadSchema(name: string, workspace?: string): Promise<{
  metadata: { id: string; name: string; createdAt: number; format: string; views?: Record<string, any> }
  enhanced: any
}> {
  const baseDir = workspace || '.schemas'
  const filePath = `${baseDir}/${name}/schema.json`

  if (!await exists(filePath)) {
    const error: any = new Error(`Schema file not found: ${filePath}`)
    error.code = 'ENOENT'
    throw error
  }

  const data = await readJson(filePath)

  const { id, name: schemaName, createdAt, format, views, ...enhanced } = data
  return {
    metadata: {
      id,
      name: schemaName,
      createdAt,
      format,
      ...(views && { views })
    },
    enhanced
  }
}

/**
 * Lists all saved schemas
 *
 * @param workspace - Optional absolute path to .schemas directory (defaults to .schemas)
 * @returns Array of schema metadata
 */
export async function listSchemas(workspace?: string): Promise<Array<{
  name: string
  id: string
  createdAt: number
  path: string
}>> {
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
