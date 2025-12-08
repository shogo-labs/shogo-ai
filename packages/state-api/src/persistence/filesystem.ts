/**
 * Filesystem-based persistence implementation.
 *
 * Supports multiple storage strategies via x-persistence schema extension:
 * - "flat": Single JSON file per model (default, backward compatible)
 *   Pattern: {location}/{schemaName}/data/{modelName}.json
 * - "entity-per-file": One JSON file per entity
 *   Pattern: {location}/{schemaName}/data/{modelName}/{entityId}.json
 * - "array-per-partition": Grouped by partition key (Phase 2)
 *   Pattern: {location}/{schemaName}/data/{modelName}/{partitionValue}.json
 *
 * This implementation reuses existing low-level file I/O utilities from io.ts
 * for consistency with the rest of the codebase.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { ensureDir, readJson, writeJson, exists, listFiles } from './io'
import { loadSchema as loadSchemaFromDisk, listSchemas as listSchemasFromDisk } from './schema-io'
import { getEffectiveStrategy, buildDisplayFilename, getPartitionValueFromFilter, applyFilter } from './helpers'
import type { IPersistenceService, PersistenceContext, EntityContext } from './types'

export class FileSystemPersistence implements IPersistenceService {
  /**
   * Save an entire collection snapshot.
   * Dispatches to strategy-specific implementation based on persistenceConfig.
   */
  async saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const strategy = getEffectiveStrategy(ctx.persistenceConfig)

    switch (strategy) {
      case 'entity-per-file':
        await this.saveCollectionEntityPerFile(ctx, snapshot)
        break
      case 'array-per-partition':
        await this.saveCollectionArrayPerPartition(ctx, snapshot)
        break
      case 'flat':
      default:
        await this.saveCollectionFlat(ctx, snapshot)
        break
    }
  }

  /**
   * Load an entire collection snapshot.
   * Dispatches to strategy-specific implementation based on persistenceConfig.
   */
  async loadCollection(ctx: PersistenceContext): Promise<any | null> {
    const strategy = getEffectiveStrategy(ctx.persistenceConfig)

    switch (strategy) {
      case 'entity-per-file':
        return this.loadCollectionEntityPerFile(ctx)
      case 'array-per-partition':
        return this.loadCollectionArrayPerPartition(ctx)
      case 'flat':
      default:
        return this.loadCollectionFlat(ctx)
    }
  }

  /**
   * Save a single entity within a collection.
   * Dispatches to strategy-specific implementation based on persistenceConfig.
   */
  async saveEntity(ctx: EntityContext, snapshot: any): Promise<void> {
    const strategy = getEffectiveStrategy(ctx.persistenceConfig)

    switch (strategy) {
      case 'entity-per-file':
        await this.saveEntityPerFile(ctx, snapshot)
        break
      case 'array-per-partition':
        await this.saveEntityArrayPerPartition(ctx, snapshot)
        break
      case 'flat':
      default:
        await this.saveEntityFlat(ctx, snapshot)
        break
    }
  }

  /**
   * Load a single entity from a collection.
   * Dispatches to strategy-specific implementation based on persistenceConfig.
   */
  async loadEntity(ctx: EntityContext): Promise<any | null> {
    const strategy = getEffectiveStrategy(ctx.persistenceConfig)

    switch (strategy) {
      case 'entity-per-file':
        return this.loadEntityPerFile(ctx)
      case 'array-per-partition':
        return this.loadEntityArrayPerPartition(ctx)
      case 'flat':
      default:
        return this.loadEntityFlat(ctx)
    }
  }

  // === Flat Strategy (default, backward compatible) ===

  /**
   * Save collection to single JSON file.
   */
  private async saveCollectionFlat(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const filePath = this.buildFlatCollectionPath(ctx)
    await ensureDir(path.dirname(filePath))
    await writeJson(filePath, snapshot)
  }

  /**
   * Load collection from single JSON file.
   * Applies filter in memory after loading.
   */
  private async loadCollectionFlat(ctx: PersistenceContext): Promise<any | null> {
    const filePath = this.buildFlatCollectionPath(ctx)

    if (!await exists(filePath)) {
      return null
    }

    try {
      const collection = await readJson(filePath)

      // Apply filter if provided
      if (ctx.filter && collection?.items) {
        return { items: applyFilter(collection.items, ctx.filter) }
      }

      return collection
    } catch (error: any) {
      throw error
    }
  }

  /**
   * Save entity using read-modify-write pattern on flat file.
   *
   * ⚠️ WARNING: NOT safe for concurrent writes.
   */
  private async saveEntityFlat(ctx: EntityContext, snapshot: any): Promise<void> {
    const collection = await this.loadCollectionFlat(ctx) || { items: {} }
    collection.items[ctx.entityId] = snapshot
    await this.saveCollectionFlat(ctx, collection)
  }

  /**
   * Load entity from flat collection file.
   */
  private async loadEntityFlat(ctx: EntityContext): Promise<any | null> {
    const collection = await this.loadCollectionFlat(ctx)
    if (!collection || !collection.items) {
      return null
    }
    return collection.items[ctx.entityId] || null
  }

  // === Entity-Per-File Strategy ===

  /**
   * Save collection by writing each entity to its own file.
   * Supports displayKey for human-readable filenames.
   */
  private async saveCollectionEntityPerFile(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const modelDir = this.buildModelDir(ctx)
    await ensureDir(modelDir)

    const items = snapshot?.items || {}
    const displayKey = ctx.persistenceConfig?.displayKey

    // Build filename mapping and check for duplicates
    const filenameToEntityId: Record<string, string> = {}

    for (const [entityId, entity] of Object.entries(items)) {
      const filename = buildDisplayFilename(entity, displayKey, entityId)

      // Check for duplicate filenames (only relevant when using displayKey)
      if (displayKey && filenameToEntityId[filename]) {
        throw new Error(
          `Duplicate displayKey value "${filename}" for entities "${filenameToEntityId[filename]}" and "${entityId}"`
        )
      }
      filenameToEntityId[filename] = entityId
    }

    // Write each entity to its own file
    for (const [entityId, entity] of Object.entries(items)) {
      const filename = buildDisplayFilename(entity, displayKey, entityId)
      const entityPath = path.join(modelDir, `${filename}.json`)
      await writeJson(entityPath, entity)
    }
  }

  /**
   * Load collection by assembling entities from directory.
   * Applies filter in memory after assembling.
   */
  private async loadCollectionEntityPerFile(ctx: PersistenceContext): Promise<any | null> {
    const modelDir = this.buildModelDir(ctx)

    if (!await exists(modelDir)) {
      return null
    }

    const files = await listFiles(modelDir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))

    if (jsonFiles.length === 0) {
      return null
    }

    const items: Record<string, any> = {}

    for (const file of jsonFiles) {
      const filePath = path.join(modelDir, file)
      const entity = await readJson(filePath)

      // Use entity's id field, falling back to filename without extension
      const entityId = entity?.id || file.replace(/\.json$/, '')
      items[entityId] = entity
    }

    // Apply filter if provided
    if (ctx.filter) {
      return { items: applyFilter(items, ctx.filter) }
    }

    return { items }
  }

  /**
   * Save single entity directly to its own file.
   * Supports displayKey for human-readable filenames.
   * Checks for conflicts when displayKey is used.
   */
  private async saveEntityPerFile(ctx: EntityContext, snapshot: any): Promise<void> {
    const modelDir = this.buildModelDir(ctx)
    await ensureDir(modelDir)

    const displayKey = ctx.persistenceConfig?.displayKey
    const filename = buildDisplayFilename(snapshot, displayKey, ctx.entityId)
    const entityPath = path.join(modelDir, `${filename}.json`)

    // Check for displayKey conflict with different entity
    if (displayKey && await exists(entityPath)) {
      const existingEntity = await readJson(entityPath)
      if (existingEntity?.id && existingEntity.id !== ctx.entityId) {
        throw new Error(
          `displayKey conflict: file "${filename}.json" already exists for entity "${existingEntity.id}"`
        )
      }
    }

    await writeJson(entityPath, snapshot)
  }

  /**
   * Load single entity from its file.
   * When displayKey is used, scans directory to find entity by id in file content.
   */
  private async loadEntityPerFile(ctx: EntityContext): Promise<any | null> {
    const modelDir = this.buildModelDir(ctx)
    const displayKey = ctx.persistenceConfig?.displayKey

    // If no displayKey, try direct file access by entityId
    if (!displayKey) {
      const entityPath = path.join(modelDir, `${ctx.entityId}.json`)
      if (!await exists(entityPath)) {
        return null
      }
      return await readJson(entityPath)
    }

    // With displayKey, we need to scan files to find by id
    if (!await exists(modelDir)) {
      return null
    }

    const files = await listFiles(modelDir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))

    for (const file of jsonFiles) {
      const filePath = path.join(modelDir, file)
      const entity = await readJson(filePath)

      if (entity?.id === ctx.entityId) {
        return entity
      }
    }

    return null
  }

  // === Array-Per-Partition Strategy ===

  /**
   * Save collection by grouping entities by partition key value.
   * Each partition value gets its own file containing all entities with that value.
   */
  private async saveCollectionArrayPerPartition(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const modelDir = this.buildModelDir(ctx)
    await ensureDir(modelDir)

    const items = snapshot?.items || {}
    const partitionKey = ctx.persistenceConfig?.partitionKey

    if (!partitionKey) {
      throw new Error('array-per-partition strategy requires partitionKey in persistenceConfig')
    }

    // Group entities by partition key value
    const partitions: Record<string, Record<string, any>> = {}

    for (const [entityId, entity] of Object.entries(items)) {
      const partitionValue = (entity as any)[partitionKey]
      if (partitionValue === undefined || partitionValue === null) {
        throw new Error(`Entity ${entityId} missing partition key "${partitionKey}"`)
      }

      if (!partitions[partitionValue]) {
        partitions[partitionValue] = {}
      }
      partitions[partitionValue][entityId] = entity
    }

    // Write each partition to its own file
    for (const [partitionValue, partitionItems] of Object.entries(partitions)) {
      const partitionPath = path.join(modelDir, `${partitionValue}.json`)
      await writeJson(partitionPath, { items: partitionItems })
    }
  }

  /**
   * Load collection by merging partition files.
   * Supports filter pushdown: if filter includes partitionKey, loads only matching partition.
   * Returns empty { items: {} } if no partitions exist.
   */
  private async loadCollectionArrayPerPartition(ctx: PersistenceContext): Promise<any> {
    const modelDir = this.buildModelDir(ctx)
    const partitionKey = ctx.persistenceConfig?.partitionKey

    if (!await exists(modelDir)) {
      return { items: {} }
    }

    // Check if we can push down filter to partition level
    const targetPartition = getPartitionValueFromFilter(ctx.filter, partitionKey)

    let items: Record<string, any> = {}

    if (targetPartition) {
      // Optimized: load only the target partition
      const partitionPath = path.join(modelDir, `${targetPartition}.json`)

      if (await exists(partitionPath)) {
        const partition = await readJson(partitionPath)
        if (partition?.items) {
          items = partition.items
        }
      }
      // If partition file doesn't exist, items remains empty
    } else {
      // Full scan: load all partition files
      const files = await listFiles(modelDir)
      const jsonFiles = files.filter(f => f.endsWith('.json'))

      for (const file of jsonFiles) {
        const filePath = path.join(modelDir, file)
        const partition = await readJson(filePath)

        // Merge partition items into main collection
        if (partition?.items) {
          Object.assign(items, partition.items)
        }
      }
    }

    // Apply any remaining filter conditions in memory
    if (ctx.filter) {
      items = applyFilter(items, ctx.filter)
    }

    return { items }
  }

  /**
   * Save entity to correct partition file based on partition key value in snapshot.
   * Uses read-modify-write on the specific partition file.
   */
  private async saveEntityArrayPerPartition(ctx: EntityContext, snapshot: any): Promise<void> {
    const modelDir = this.buildModelDir(ctx)
    await ensureDir(modelDir)

    const partitionKey = ctx.persistenceConfig?.partitionKey

    if (!partitionKey) {
      throw new Error('array-per-partition strategy requires partitionKey in persistenceConfig')
    }

    const partitionValue = snapshot[partitionKey]
    if (partitionValue === undefined || partitionValue === null) {
      throw new Error(`Entity snapshot missing partition key "${partitionKey}"`)
    }

    const partitionPath = path.join(modelDir, `${partitionValue}.json`)

    // Read-modify-write on the specific partition file
    let partition = { items: {} as Record<string, any> }
    if (await exists(partitionPath)) {
      partition = await readJson(partitionPath)
    }

    partition.items[ctx.entityId] = snapshot
    await writeJson(partitionPath, partition)
  }

  /**
   * Load entity by scanning all partition files.
   * Returns undefined if not found in any partition.
   */
  private async loadEntityArrayPerPartition(ctx: EntityContext): Promise<any | undefined> {
    const modelDir = this.buildModelDir(ctx)

    if (!await exists(modelDir)) {
      return undefined
    }

    const files = await listFiles(modelDir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))

    for (const file of jsonFiles) {
      const filePath = path.join(modelDir, file)
      const partition = await readJson(filePath)

      if (partition?.items?.[ctx.entityId]) {
        return partition.items[ctx.entityId]
      }
    }

    return undefined
  }

  // === Path Building Helpers ===

  /**
   * Build path for flat collection file.
   * Pattern: {location}/{schemaName}/data/{modelName}.json
   */
  private buildFlatCollectionPath(ctx: PersistenceContext): string {
    const baseDir = ctx.location || '.schemas'
    return path.join(baseDir, ctx.schemaName, 'data', `${ctx.modelName}.json`)
  }

  /**
   * Build directory path for entity-per-file storage.
   * Pattern: {location}/{schemaName}/data/{modelName}/
   */
  private buildModelDir(ctx: PersistenceContext): string {
    const baseDir = ctx.location || '.schemas'
    return path.join(baseDir, ctx.schemaName, 'data', ctx.modelName)
  }

  // === Schema operations (for isomorphic support) ===

  /**
   * Load a schema from disk.
   * Delegates to schema-io.ts for actual file operations.
   */
  async loadSchema(name: string, location?: string): Promise<{
    metadata: { name: string; id?: string; views?: Record<string, any> }
    enhanced: any
  } | null> {
    try {
      return await loadSchemaFromDisk(name, location)
    } catch (error: any) {
      // Return null for "not found" errors, re-throw others
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  /**
   * List available schemas from disk.
   * Delegates to schema-io.ts for actual directory listing.
   */
  async listSchemas(location?: string): Promise<string[]> {
    // schema-io listSchemas doesn't support workspace param, but returns objects
    // We just need the names
    const schemas = await listSchemasFromDisk()
    return schemas.map(s => s.name)
  }
}
