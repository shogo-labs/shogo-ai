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
import {
  getEffectiveStrategy,
  buildDisplayFilename,
  getPartitionValueFromFilter,
  applyFilter,
  findParentReference,
  findParentChain,
  buildNestedCollectionPath,
  buildMultiLevelNestedPath,
  buildParentEntityPath,
  hasNestedChildren,
  sanitizeFilename
} from './helpers'
import type { IPersistenceService, PersistenceContext, EntityContext, NestedParentContext, NestedParentChainItem } from './types'

export class FileSystemPersistence implements IPersistenceService {
  /**
   * Save an entire collection snapshot.
   * Dispatches to strategy-specific implementation based on persistenceConfig.
   */
  async saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void> {
    // Phase 8: Check for nested persistence first
    if (ctx.persistenceConfig?.nested && ctx.schemaDefs) {
      await this.saveCollectionNested(ctx, snapshot)
      return
    }

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
    // Phase 8: Check for nested persistence first
    if (ctx.persistenceConfig?.nested && ctx.schemaDefs) {
      return this.loadCollectionNested(ctx)
    }

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

    // Phase 9: Check if this model has nested children (determines _index.json usage)
    const hasChildren = ctx.schemaDefs && hasNestedChildren(ctx.modelName, ctx.schemaDefs)

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

      if (hasChildren && displayKey) {
        // Phase 9: Entity with children uses folder + _index.json
        const folderPath = path.join(modelDir, filename)
        await ensureDir(folderPath)
        const entityPath = path.join(folderPath, '_index.json')
        await writeJson(entityPath, entity)
      } else {
        // Standard: direct JSON file
        const entityPath = path.join(modelDir, `${filename}.json`)
        await writeJson(entityPath, entity)
      }
    }
  }

  /**
   * Load collection by assembling entities from directory.
   * Applies filter in memory after assembling.
   *
   * Phase 9: If this model has nested children, looks in subdirectories
   * for _index.json files (preferred) or legacy {model}.json files.
   */
  private async loadCollectionEntityPerFile(ctx: PersistenceContext): Promise<any | null> {
    const modelDir = this.buildModelDir(ctx)

    if (!await exists(modelDir)) {
      return null
    }

    const items: Record<string, any> = {}
    const displayKey = ctx.persistenceConfig?.displayKey

    // Phase 9: Check if this model has nested children
    const hasChildren = ctx.schemaDefs && hasNestedChildren(ctx.modelName, ctx.schemaDefs)

    if (hasChildren && displayKey) {
      // Parent with nested children: scan subdirectories for _index.json or legacy files
      const subDirs = await this.listDirs(modelDir)
      const lowercaseModel = ctx.modelName.toLowerCase()

      for (const subDir of subDirs) {
        // Phase 9: Prefer _index.json, fallback to legacy {model}.json
        const indexPath = path.join(modelDir, subDir, '_index.json')
        const legacyPath = path.join(modelDir, subDir, `${lowercaseModel}.json`)

        let entity: any = null
        if (await exists(indexPath)) {
          entity = await readJson(indexPath)
        } else if (await exists(legacyPath)) {
          entity = await readJson(legacyPath)
        }

        if (entity) {
          const entityId = entity?.id || subDir
          items[entityId] = entity
        }
      }
    } else {
      // Standard entity-per-file: scan JSON files in model directory
      const files = await listFiles(modelDir)
      const jsonFiles = files.filter(f => f.endsWith('.json'))

      for (const file of jsonFiles) {
        const filePath = path.join(modelDir, file)
        const entity = await readJson(filePath)

        // Use entity's id field, falling back to filename without extension
        const entityId = entity?.id || file.replace(/\.json$/, '')
        items[entityId] = entity
      }
    }

    if (Object.keys(items).length === 0) {
      return null
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
   *
   * Phase 8: If this model has nested children, stores the entity in a folder
   * with lowercase model name (e.g., Initiative/Auth Layer/initiative.json).
   */
  private async saveEntityPerFile(ctx: EntityContext, snapshot: any): Promise<void> {
    const displayKey = ctx.persistenceConfig?.displayKey
    const filename = buildDisplayFilename(snapshot, displayKey, ctx.entityId)

    // Phase 8: Check if this model has nested children
    const hasChildren = ctx.schemaDefs && hasNestedChildren(ctx.modelName, ctx.schemaDefs)

    let entityPath: string

    if (hasChildren && displayKey) {
      // Parent with nested children: store in folder structure
      // e.g., Initiative/Auth Layer/initiative.json
      entityPath = buildParentEntityPath(ctx, filename)
    } else {
      // Standard entity-per-file: store in model directory
      entityPath = path.join(this.buildModelDir(ctx), `${filename}.json`)
    }

    await ensureDir(path.dirname(entityPath))

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
   *
   * Phase 8: If this model has nested children, looks in folder structure.
   */
  private async loadEntityPerFile(ctx: EntityContext): Promise<any | null> {
    const modelDir = this.buildModelDir(ctx)
    const displayKey = ctx.persistenceConfig?.displayKey

    // Phase 9: Check if this model has nested children
    const hasChildren = ctx.schemaDefs && hasNestedChildren(ctx.modelName, ctx.schemaDefs)

    if (hasChildren && displayKey) {
      // Parent with nested children: scan subdirectories for entity
      if (!await exists(modelDir)) {
        return null
      }

      const subDirs = await this.listDirs(modelDir)
      for (const subDir of subDirs) {
        const lowercaseModel = ctx.modelName.toLowerCase()
        // Phase 9: Prefer _index.json, fallback to legacy {model}.json
        const indexPath = path.join(modelDir, subDir, '_index.json')
        const legacyPath = path.join(modelDir, subDir, `${lowercaseModel}.json`)

        let entity: any = null
        if (await exists(indexPath)) {
          entity = await readJson(indexPath)
        } else if (await exists(legacyPath)) {
          entity = await readJson(legacyPath)
        }

        if (entity?.id === ctx.entityId) {
          return entity
        }
      }
      return null
    }

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

  // === Nested Strategy (Phase 8) ===

  /**
   * Save nested collection - entities stored under parent folders.
   *
   * Groups entities by parent reference, then saves each group
   * under the parent's display key folder.
   */
  /**
   * Save nested collection - entities stored under parent folders.
   * Phase 9: Supports multi-level nesting by building full parent chain paths.
   */
  private async saveCollectionNested(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const items = snapshot?.items || {}

    if (Object.keys(items).length === 0) {
      return // Nothing to save
    }

    // Find immediate parent reference info from schema
    const modelDef = ctx.schemaDefs?.[ctx.modelName]
    const parentInfo = findParentReference(modelDef, ctx.schemaDefs!)

    if (!parentInfo) {
      throw new Error(`Cannot save nested collection: no parent info for ${ctx.modelName}`)
    }

    // Phase 9: Find full parent chain for multi-level nesting
    const parentChainInfo = findParentChain(ctx.modelName, ctx.schemaDefs!)

    // Group entities by immediate parent ID
    const byParent: Record<string, Record<string, any>> = {}

    for (const [entityId, entity] of Object.entries(items)) {
      const parentId = (entity as any)[parentInfo.field]
      if (!parentId) {
        throw new Error(
          `Entity ${entityId} missing parent reference field "${parentInfo.field}"`
        )
      }

      if (!byParent[parentId]) {
        byParent[parentId] = {}
      }
      byParent[parentId][entityId] = entity
    }

    const strategy = ctx.persistenceConfig?.strategy || 'entity-per-file'

    // For each parent group, resolve full parent chain and save children
    for (const [parentId, parentItems] of Object.entries(byParent)) {
      // Phase 9: Build full parent chain with resolved display values
      const resolvedChain = await this.resolveParentChain(
        ctx, parentChainInfo, parentId
      )

      let nestedCtx: PersistenceContext

      if (resolvedChain.length > 0) {
        // Multi-level: use parentChain
        nestedCtx = {
          ...ctx,
          parentChain: resolvedChain
        }
      } else {
        // Single-level fallback: use parentContext
        const parentDisplayValue = await this.resolveParentDisplayValue(
          ctx, parentInfo, parentId
        )
        nestedCtx = {
          ...ctx,
          parentContext: {
            modelName: parentInfo.targetModel,
            displayKeyValue: sanitizeFilename(parentDisplayValue)
          }
        }
      }

      if (strategy === 'array-per-partition') {
        // Nested + array-per-partition: single _items.json per parent
        await this.saveNestedArrayPartition(nestedCtx, { items: parentItems })
      } else {
        // Nested + entity-per-file: individual files per entity
        await this.saveNestedEntityPerFile(nestedCtx, { items: parentItems })
      }
    }
  }

  /**
   * Resolve full parent chain display values for multi-level nesting.
   * Phase 9: Walks up from immediate parent to root, collecting display values.
   */
  private async resolveParentChain(
    ctx: PersistenceContext,
    chainInfo: Array<{ field: string; targetModel: string; parentDisplayKey: string }>,
    immediateParentId: string
  ): Promise<NestedParentChainItem[]> {
    if (chainInfo.length === 0) {
      return []
    }

    const result: NestedParentChainItem[] = []
    let currentEntityId = immediateParentId

    for (const parentInfo of chainInfo) {
      // Load the parent entity to get its displayKey value and its own parent ref
      const parentCollection = await this.loadCollection({
        schemaName: ctx.schemaName,
        modelName: parentInfo.targetModel,
        location: ctx.location,
        persistenceConfig: ctx.schemaDefs?.[parentInfo.targetModel]?.['x-persistence'],
        schemaDefs: ctx.schemaDefs
      })

      const parentEntity = parentCollection?.items?.[currentEntityId]
      if (!parentEntity) {
        throw new Error(
          `Parent ${parentInfo.targetModel} with ID ${currentEntityId} not found`
        )
      }

      const displayValue = parentEntity[parentInfo.parentDisplayKey]
      if (!displayValue) {
        throw new Error(
          `Parent ${currentEntityId} missing displayKey field "${parentInfo.parentDisplayKey}"`
        )
      }

      result.push({
        modelName: parentInfo.targetModel,
        displayKeyValue: sanitizeFilename(String(displayValue)),
        referenceField: parentInfo.field
      })

      // Find next parent ID in chain (if there is one)
      const nextParentInfo = chainInfo[result.length]
      if (nextParentInfo) {
        currentEntityId = parentEntity[nextParentInfo.field]
        if (!currentEntityId) {
          break // No more parents in chain
        }
      }
    }

    return result
  }

  /**
   * Save nested entities as individual files under parent folder.
   * Phase 9: If entity has nested children, use folder/_index.json format.
   * Phase 9: Supports multi-level nesting via parentChain.
   */
  private async saveNestedEntityPerFile(ctx: PersistenceContext, snapshot: any): Promise<void> {
    // Phase 9: Use multi-level path if parentChain exists, else single-level
    const nestedDir = ctx.parentChain?.length
      ? buildMultiLevelNestedPath(ctx)
      : buildNestedCollectionPath(ctx)
    await ensureDir(nestedDir)

    const items = snapshot?.items || {}
    const displayKey = ctx.persistenceConfig?.displayKey

    // Phase 9: Check if this model has nested children (determines _index.json usage)
    const hasChildren = ctx.schemaDefs && hasNestedChildren(ctx.modelName, ctx.schemaDefs)

    for (const [entityId, entity] of Object.entries(items)) {
      const filename = buildDisplayFilename(entity, displayKey, entityId)

      if (hasChildren && displayKey) {
        // Phase 9: Entity with children uses folder + _index.json
        const folderPath = path.join(nestedDir, filename)
        await ensureDir(folderPath)
        const entityPath = path.join(folderPath, '_index.json')
        await writeJson(entityPath, entity)
      } else {
        // Leaf entity: direct JSON file
        const entityPath = path.join(nestedDir, `${filename}.json`)
        await writeJson(entityPath, entity)
      }
    }
  }

  /**
   * Save nested entities as array in _items.json under parent folder.
   * Phase 9: Supports multi-level nesting via parentChain.
   */
  private async saveNestedArrayPartition(ctx: PersistenceContext, snapshot: any): Promise<void> {
    // Use multi-level path if parentChain exists, else single-level
    const nestedDir = ctx.parentChain?.length
      ? buildMultiLevelNestedPath(ctx)
      : buildNestedCollectionPath(ctx)
    await ensureDir(nestedDir)

    const itemsPath = path.join(nestedDir, '_items.json')
    await writeJson(itemsPath, snapshot)
  }

  /**
   * Load nested collection - scan parent folders for child entities.
   *
   * With filter pushdown: if filter includes parent ID, only scan
   * that parent's folder.
   */
  /**
   * Load nested collection - scan parent folders for child entities.
   * Phase 9: Supports multi-level nesting via recursive directory scanning.
   */
  private async loadCollectionNested(ctx: PersistenceContext): Promise<any> {
    const modelDef = ctx.schemaDefs?.[ctx.modelName]
    const parentInfo = findParentReference(modelDef, ctx.schemaDefs!)

    if (!parentInfo) {
      return { items: {} }
    }

    let items: Record<string, any> = {}
    const strategy = ctx.persistenceConfig?.strategy || 'entity-per-file'
    const baseDir = ctx.location || '.schemas'

    // Phase 9: Recursively find all {modelName} folders in the data tree
    const dataDir = path.join(baseDir, ctx.schemaName, 'data')
    if (!await exists(dataDir)) {
      return { items: {} }
    }

    // Find all directories named after this model in the hierarchy
    const modelDirs = await this.findNestedModelDirs(dataDir, ctx.modelName)

    for (const modelDir of modelDirs) {
      const folderItems = await this.loadNestedFromDir(modelDir, ctx, strategy)
      Object.assign(items, folderItems)
    }

    // Apply filter conditions in memory
    if (ctx.filter) {
      items = applyFilter(items, ctx.filter)
    }

    return { items }
  }

  /**
   * Recursively find all directories matching modelName in the data hierarchy.
   * Phase 9: Supports multi-level nested structures.
   */
  private async findNestedModelDirs(dir: string, modelName: string): Promise<string[]> {
    const results: string[] = []

    if (!await exists(dir)) {
      return results
    }

    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const entryPath = path.join(dir, entry.name)

      if (entry.name === modelName) {
        // Found a model directory
        results.push(entryPath)
      } else {
        // Recurse into subdirectories
        const nested = await this.findNestedModelDirs(entryPath, modelName)
        results.push(...nested)
      }
    }

    return results
  }

  /**
   * Load entities from a nested child directory.
   * Phase 9: Supports _index.json convention for entities with children.
   */
  private async loadNestedFromDir(
    dir: string,
    ctx: PersistenceContext,
    strategy: string
  ): Promise<Record<string, any>> {
    const items: Record<string, any> = {}

    if (strategy === 'array-per-partition') {
      // Load from _items.json
      const itemsPath = path.join(dir, '_items.json')
      if (await exists(itemsPath)) {
        const data = await readJson(itemsPath)
        if (data?.items) {
          Object.assign(items, data.items)
        }
      }
    } else {
      // Load individual entity files and _index.json from subdirectories
      const entries = await fs.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name)

        if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== '_items.json') {
          // Direct JSON file (leaf entity)
          const entity = await readJson(entryPath)
          const entityId = entity?.id || entry.name.replace(/\.json$/, '')
          items[entityId] = entity
        } else if (entry.isDirectory()) {
          // Phase 9: Check for _index.json in subdirectory (entity with children)
          const indexPath = path.join(entryPath, '_index.json')
          if (await exists(indexPath)) {
            const entity = await readJson(indexPath)
            const entityId = entity?.id || entry.name
            items[entityId] = entity
          }
        }
      }
    }

    return items
  }

  /**
   * Resolve a parent entity's display key value from its ID.
   *
   * Phase 9: Uses loadCollection for nested parents to handle multi-level nesting.
   * Falls back to loadEntity for non-nested parents (more efficient).
   */
  private async resolveParentDisplayValue(
    ctx: PersistenceContext,
    parentInfo: { field: string; targetModel: string; parentDisplayKey: string },
    parentId: string
  ): Promise<string> {
    const parentPersistenceConfig = ctx.schemaDefs?.[parentInfo.targetModel]?.['x-persistence']

    // Phase 9: Check if parent is itself nested (requires loadCollection approach)
    const parentIsNested = parentPersistenceConfig?.nested === true

    let parent: any = null

    if (parentIsNested && ctx.schemaDefs) {
      // Parent is nested - use loadCollection with filter to find it
      const collectionCtx: PersistenceContext = {
        schemaName: ctx.schemaName,
        modelName: parentInfo.targetModel,
        location: ctx.location,
        persistenceConfig: parentPersistenceConfig,
        schemaDefs: ctx.schemaDefs,
        filter: { id: parentId } // Won't actually filter by ID, but needed for context
      }
      const result = await this.loadCollection(collectionCtx)
      if (result?.items) {
        parent = result.items[parentId]
      }
    } else {
      // Non-nested parent - use efficient loadEntity
      const parentCtx: EntityContext = {
        schemaName: ctx.schemaName,
        modelName: parentInfo.targetModel,
        location: ctx.location,
        entityId: parentId,
        persistenceConfig: parentPersistenceConfig,
        schemaDefs: ctx.schemaDefs
      }
      parent = await this.loadEntity(parentCtx)

      // Fallback: try without schemaDefs (flat structure)
      if (!parent && ctx.schemaDefs) {
        const flatCtx: EntityContext = {
          schemaName: ctx.schemaName,
          modelName: parentInfo.targetModel,
          location: ctx.location,
          entityId: parentId,
          persistenceConfig: parentPersistenceConfig
          // No schemaDefs - forces flat file lookup
        }
        parent = await this.loadEntity(flatCtx)
      }
    }

    if (!parent) {
      throw new Error(
        `Parent ${parentInfo.targetModel} with ID ${parentId} not found`
      )
    }

    const displayValue = parent[parentInfo.parentDisplayKey]
    if (!displayValue) {
      throw new Error(
        `Parent ${parentId} missing displayKey field "${parentInfo.parentDisplayKey}"`
      )
    }

    return String(displayValue)
  }

  /**
   * List subdirectories in a directory (excluding files).
   */
  private async listDirs(dirPath: string): Promise<string[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
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
