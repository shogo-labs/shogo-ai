/**
 * Collection data save/load operations
 */

import { ensureDir, readJson, writeJson, exists, listFiles } from './io'

/**
 * Saves a collection snapshot to disk
 *
 * @param schemaName - Schema name (folder name)
 * @param modelName - Model name (e.g., "Task", "User")
 * @param snapshot - MST collection snapshot
 * @param workspace - Optional absolute path to workspace directory (defaults to .schemas)
 */
export async function saveCollection(
  schemaName: string,
  modelName: string,
  snapshot: any,
  workspace?: string
): Promise<void> {
  const baseDir = workspace || '.schemas'
  const dir = `${baseDir}/${schemaName}/data`
  await ensureDir(dir)
  await writeJson(`${dir}/${modelName}.json`, snapshot)
}

/**
 * Loads all collection snapshots for a schema
 *
 * @param schemaName - Schema name (folder name)
 * @param workspace - Optional absolute path to workspace directory (defaults to .schemas)
 * @returns Map of model name to collection snapshot
 */
export async function loadCollections(schemaName: string, workspace?: string): Promise<Map<string, any>> {
  const baseDir = workspace || '.schemas'
  const dir = `${baseDir}/${schemaName}/data`
  if (!await exists(dir)) return new Map()

  const files = await listFiles(dir)
  const collections = new Map()

  for (const file of files) {
    if (file.endsWith('.json')) {
      const modelName = file.replace('.json', '')
      const snapshot = await readJson(`${dir}/${file}`)
      collections.set(modelName, snapshot)
    }
  }

  return collections
}

/**
 * Loads a single collection snapshot from disk
 *
 * @param schemaName - Schema name (folder name)
 * @param modelName - Model name (e.g., "Task", "User")
 * @param workspace - Optional absolute path to workspace directory (defaults to .schemas)
 * @returns Collection snapshot or null if not found
 */
export async function loadCollection(
  schemaName: string,
  modelName: string,
  workspace?: string
): Promise<any> {
  const baseDir = workspace || '.schemas'
  const filePath = `${baseDir}/${schemaName}/data/${modelName}.json`
  if (!await exists(filePath)) return null
  return await readJson(filePath)
}
