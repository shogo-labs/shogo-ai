/**
 * Persistence Helper Functions
 *
 * Utilities for working with partitioned persistence, including
 * extracting configuration from schema definitions and building file paths.
 */
import path from 'path'
import type { PersistenceConfig, PersistenceContext } from './types'

/**
 * Information about a parent reference discovered from schema.
 * Used for nested persistence to determine parent-child relationships.
 */
export type NestedParentInfo = {
  /** Field name on child that references parent (e.g., "initiativeId") */
  field: string
  /** Target model name (e.g., "Initiative") */
  targetModel: string
  /** DisplayKey field name on parent (e.g., "name") */
  parentDisplayKey: string
}

/**
 * Default persistence configuration (flat strategy, backward compatible).
 */
const DEFAULT_CONFIG: PersistenceConfig = {
  strategy: 'flat',
  partitionKey: undefined,
  displayKey: undefined
}

/**
 * Extract persistence configuration from a model definition.
 *
 * Reads the `x-persistence` extension from a schema model definition
 * and returns a normalized PersistenceConfig object.
 *
 * @param modelDef - The model definition object from schema.$defs[ModelName]
 * @returns PersistenceConfig with defaults applied
 *
 * @example
 * const config = extractPersistenceConfig({
 *   type: 'object',
 *   'x-persistence': { strategy: 'entity-per-file' },
 *   properties: { ... }
 * })
 * // Returns: { strategy: 'entity-per-file', partitionKey: undefined, displayKey: undefined }
 */
export function extractPersistenceConfig(modelDef: any): PersistenceConfig {
  // Handle null/undefined input
  if (!modelDef) {
    return { ...DEFAULT_CONFIG }
  }

  const xPersistence = modelDef['x-persistence']

  // No x-persistence extension - use defaults
  if (!xPersistence) {
    return { ...DEFAULT_CONFIG }
  }

  // Extract and validate strategy
  const strategy = xPersistence.strategy
  if (!strategy || !['flat', 'entity-per-file', 'array-per-partition'].includes(strategy)) {
    return { ...DEFAULT_CONFIG }
  }

  return {
    strategy,
    partitionKey: xPersistence.partitionKey,
    displayKey: xPersistence.displayKey,
    nested: xPersistence.nested
  }
}

/**
 * Get the effective strategy from a PersistenceConfig, defaulting to 'flat'.
 *
 * @param config - Optional persistence config
 * @returns The strategy to use
 */
export function getEffectiveStrategy(config?: PersistenceConfig): PersistenceConfig['strategy'] {
  return config?.strategy || 'flat'
}

/**
 * Sanitize a string for use as a filename.
 *
 * Replaces filesystem-unsafe characters with underscores and trims whitespace.
 * Unsafe chars: / \ : * ? " < > |
 *
 * @param input - The string to sanitize
 * @returns A filesystem-safe string
 */
export function sanitizeFilename(input: string): string {
  // Replace unsafe characters with underscore
  const sanitized = input.replace(/[/\\:*?"<>|]/g, '_')
  // Trim leading/trailing whitespace
  return sanitized.trim()
}

/**
 * Build a display filename for an entity.
 *
 * Uses the displayKey value if available and non-empty, otherwise falls back to entity id.
 *
 * @param entity - The entity object
 * @param displayKey - The property name to use for display
 * @param entityId - Fallback entity id
 * @returns Sanitized filename (without extension)
 */
export function buildDisplayFilename(entity: any, displayKey: string | undefined, entityId: string): string {
  if (!displayKey) {
    return entityId
  }

  const displayValue = entity[displayKey]

  // Fall back to id if display value is missing or empty
  if (displayValue === undefined || displayValue === null || displayValue === '') {
    return entityId
  }

  return sanitizeFilename(String(displayValue))
}

/**
 * Check if a filter can be pushed down to partition level.
 *
 * Returns the partition value if filter contains the partitionKey,
 * otherwise returns undefined (meaning full scan is needed).
 *
 * @param filter - The filter object
 * @param partitionKey - The partition key field name
 * @returns The partition value to target, or undefined for full scan
 */
export function getPartitionValueFromFilter(
  filter: Record<string, any> | undefined,
  partitionKey: string | undefined
): string | undefined {
  if (!filter || !partitionKey) {
    return undefined
  }

  const partitionValue = filter[partitionKey]

  // Only support simple string equality for now
  if (typeof partitionValue === 'string') {
    return partitionValue
  }

  return undefined
}

/**
 * Apply a simple equality filter to a collection of items.
 *
 * @param items - Object mapping entity IDs to entities
 * @param filter - Simple key-value equality filter
 * @returns Filtered items object
 */
export function applyFilter(
  items: Record<string, any>,
  filter: Record<string, any> | undefined
): Record<string, any> {
  if (!filter || Object.keys(filter).length === 0) {
    return items
  }

  const result: Record<string, any> = {}

  for (const [id, entity] of Object.entries(items)) {
    let matches = true

    for (const [key, value] of Object.entries(filter)) {
      if (entity[key] !== value) {
        matches = false
        break
      }
    }

    if (matches) {
      result[id] = entity
    }
  }

  return result
}

// ============================================================================
// Nested Persistence Helpers (Phase 8)
// ============================================================================

/**
 * Find the parent reference field in a model's schema definition.
 *
 * Looks for a single reference field marked with:
 * - x-reference-type: "single"
 * - x-mst-type: "reference"
 *
 * Only searches when the model has `nested: true` in its x-persistence config.
 *
 * @param modelDef - Schema definition from $defs[ModelName]
 * @param allDefs - All model definitions (to look up parent's displayKey)
 * @returns Parent info or null if not a nested model
 * @throws Error if model has nested:true but no valid parent reference
 *
 * @example
 * const parentInfo = findParentReference(schema.$defs.BacklogItem, schema.$defs)
 * // Returns: { field: 'initiativeId', targetModel: 'Initiative', parentDisplayKey: 'name' }
 */
export function findParentReference(
  modelDef: any,
  allDefs: Record<string, any>
): NestedParentInfo | null {
  const xPersistence = modelDef?.['x-persistence']

  // Only look for parent if nested: true
  if (!xPersistence?.nested) {
    return null
  }

  const properties = modelDef?.properties || {}
  let parentField: string | null = null
  let parentRef: string | null = null

  // Collect all single references first
  const partitionKey = xPersistence?.partitionKey
  const singleRefs: Array<{ field: string; target: string }> = []

  for (const [propName, propSchema] of Object.entries(properties)) {
    const schema = propSchema as any
    if (schema['x-reference-type'] === 'single' &&
        schema['x-mst-type'] === 'reference') {
      const target = schema.$ref?.replace('#/$defs/', '') ||
                     schema['x-arktype']?.replace('[]', '').split('.').pop()
      singleRefs.push({ field: propName, target })
    }
  }

  // Determine parent field
  if (singleRefs.length === 1) {
    parentField = singleRefs[0].field
    parentRef = singleRefs[0].target
  } else if (singleRefs.length > 1) {
    // Multiple refs - use partitionKey as discriminator if available
    const match = singleRefs.find(r => r.field === partitionKey)
    if (match) {
      parentField = match.field
      parentRef = match.target
    } else {
      throw new Error(
        `Model with nested:true has multiple single references: ${singleRefs.map(r => r.field).join(', ')}. ` +
        `Cannot determine parent automatically. Set partitionKey to one of these fields to disambiguate.`
      )
    }
  }

  if (!parentField || !parentRef) {
    throw new Error(
      `Model with nested:true has no single reference field. ` +
      `Add a reference field with x-reference-type: "single" to establish parent relationship.`
    )
  }

  // Lookup parent's displayKey
  const parentDef = allDefs[parentRef]
  if (!parentDef) {
    throw new Error(`Parent model "${parentRef}" not found in schema $defs`)
  }

  const parentDisplayKey = parentDef['x-persistence']?.displayKey
  if (!parentDisplayKey) {
    throw new Error(
      `Parent model "${parentRef}" must have x-persistence.displayKey for nested children`
    )
  }

  return {
    field: parentField,
    targetModel: parentRef,
    parentDisplayKey: parentDisplayKey
  }
}

/**
 * Find the complete parent chain for a nested model.
 *
 * Walks up the reference chain from child to root, returning an array
 * ordered from immediate parent to ultimate root ancestor.
 *
 * @param modelName - Name of the model to find parents for
 * @param allDefs - All model definitions from schema.$defs
 * @returns Array of parent info, empty if not nested or is root
 *
 * @example
 * // For Employee nested under Team → Department → Organization:
 * findParentChain('Employee', schema.$defs)
 * // Returns: [
 * //   { field: 'team', targetModel: 'Team', parentDisplayKey: 'name' },
 * //   { field: 'department', targetModel: 'Department', parentDisplayKey: 'name' },
 * //   { field: 'organization', targetModel: 'Organization', parentDisplayKey: 'name' }
 * // ]
 */
export function findParentChain(
  modelName: string,
  allDefs: Record<string, any>
): NestedParentInfo[] {
  const chain: NestedParentInfo[] = []
  let currentModel = modelName
  const visited = new Set<string>() // Circular reference protection

  while (true) {
    // Prevent infinite loops from circular references
    if (visited.has(currentModel)) {
      break
    }
    visited.add(currentModel)

    const modelDef = allDefs[currentModel]
    if (!modelDef) {
      break
    }

    const parentInfo = findParentReference(modelDef, allDefs)
    if (!parentInfo) {
      break // Reached a non-nested model (root)
    }

    chain.push(parentInfo)
    currentModel = parentInfo.targetModel
  }

  return chain
}

/**
 * Build the directory path for a nested collection.
 *
 * Creates path: {location}/{schemaName}/data/{ParentModel}/{parentDisplayKey}/{ChildModel}/
 *
 * @param ctx - Persistence context with parentContext populated
 * @returns Directory path for nested entities
 * @throws Error if parentContext is not provided
 *
 * @example
 * buildNestedCollectionPath({
 *   schemaName: 'roadmap',
 *   modelName: 'BacklogItem',
 *   location: '.schemas',
 *   parentContext: { modelName: 'Initiative', displayKeyValue: 'auth-layer-v2' }
 * })
 * // Returns: '.schemas/roadmap/data/Initiative/auth-layer-v2/BacklogItem'
 */
export function buildNestedCollectionPath(ctx: PersistenceContext): string {
  if (!ctx.parentContext) {
    throw new Error('buildNestedCollectionPath requires parentContext')
  }

  const baseDir = ctx.location || '.schemas'
  return path.join(
    baseDir,
    ctx.schemaName,
    'data',
    ctx.parentContext.modelName,
    ctx.parentContext.displayKeyValue,
    ctx.modelName
  )
}

/**
 * Build directory path for multi-level nested collection.
 *
 * Constructs a path that reflects the full parent chain hierarchy,
 * walking from root ancestor down to the immediate parent.
 *
 * @param ctx - Persistence context with parentChain populated
 * @returns Directory path for multi-level nested entities
 * @throws Error if parentChain is not provided or empty
 *
 * @example
 * // For Employee nested under Team → Department → Organization:
 * buildMultiLevelNestedPath({
 *   schemaName: 'test',
 *   modelName: 'Employee',
 *   location: '.schemas',
 *   parentChain: [
 *     { modelName: 'Team', displayKeyValue: 'platform', referenceField: 'team' },
 *     { modelName: 'Department', displayKeyValue: 'engineering', referenceField: 'department' },
 *     { modelName: 'Organization', displayKeyValue: 'acme-corp', referenceField: 'organization' }
 *   ]
 * })
 * // Returns: '.schemas/test/data/Organization/acme-corp/Department/engineering/Team/platform/Employee'
 */
export function buildMultiLevelNestedPath(ctx: PersistenceContext): string {
  if (!ctx.parentChain?.length) {
    throw new Error('buildMultiLevelNestedPath requires parentChain')
  }

  const baseDir = ctx.location || '.schemas'
  const parts = [baseDir, ctx.schemaName, 'data']

  // Walk chain in reverse (root → immediate parent)
  for (let i = ctx.parentChain.length - 1; i >= 0; i--) {
    parts.push(ctx.parentChain[i].modelName)
    parts.push(ctx.parentChain[i].displayKeyValue)
  }

  parts.push(ctx.modelName)
  return path.join(...parts)
}

/**
 * Build the file path for a parent entity in nested structure.
 *
 * When the entity has nested children (detected via schemaDefs), uses `_index.json`
 * convention. Otherwise uses `{lowercase-model}.json`.
 *
 * Creates path:
 * - With children: {location}/{schemaName}/data/{Model}/{displayKeyValue}/_index.json
 * - Without children: {location}/{schemaName}/data/{Model}/{displayKeyValue}/{model}.json
 *
 * @param ctx - Persistence context for the parent model (schemaDefs enables auto-detection)
 * @param displayKeyValue - The sanitized display key value for folder name
 * @returns File path for the parent entity
 *
 * @example
 * // Parent with nested children (auto-detected via schemaDefs):
 * buildParentEntityPath(
 *   { schemaName: 'test', modelName: 'Organization', location: '.schemas', schemaDefs: {...} },
 *   'acme-corp'
 * )
 * // Returns: '.schemas/test/data/Organization/acme-corp/_index.json'
 *
 * // Leaf entity without children:
 * buildParentEntityPath(
 *   { schemaName: 'roadmap', modelName: 'Initiative', location: '.schemas' },
 *   'auth-layer-v2'
 * )
 * // Returns: '.schemas/roadmap/data/Initiative/auth-layer-v2/initiative.json'
 */
export function buildParentEntityPath(
  ctx: PersistenceContext,
  displayKeyValue: string
): string {
  const baseDir = ctx.location || '.schemas'

  // Auto-detect if this entity has nested children
  const entityHasChildren = ctx.schemaDefs
    ? hasNestedChildren(ctx.modelName, ctx.schemaDefs)
    : false

  const filename = entityHasChildren
    ? '_index.json'
    : `${ctx.modelName.toLowerCase()}.json`

  return path.join(
    baseDir,
    ctx.schemaName,
    'data',
    ctx.modelName,
    displayKeyValue,
    filename
  )
}

/**
 * Check if a model has nested children based on schema definitions.
 *
 * Scans all model definitions to find any that have:
 * - nested: true in x-persistence
 * - A single reference pointing to the given model
 *
 * @param modelName - The model name to check for nested children
 * @param allDefs - All model definitions from schema.$defs
 * @returns True if any model is nested under this one
 */
export function hasNestedChildren(
  modelName: string,
  allDefs: Record<string, any>
): boolean {
  for (const [, modelDef] of Object.entries(allDefs)) {
    const xPersistence = modelDef?.['x-persistence']
    if (!xPersistence?.nested) continue

    // Check if this model's parent is the target
    const properties = modelDef?.properties || {}
    for (const [, propSchema] of Object.entries(properties)) {
      const schema = propSchema as any
      if (schema['x-reference-type'] === 'single' &&
          schema['x-mst-type'] === 'reference') {
        const targetRef = schema.$ref?.replace('#/$defs/', '') ||
                          schema['x-arktype']?.replace('[]', '').split('.').pop()
        if (targetRef === modelName) {
          return true
        }
      }
    }
  }
  return false
}
