/**
 * Persistence Helper Functions
 *
 * Utilities for working with partitioned persistence, including
 * extracting configuration from schema definitions and building file paths.
 */
import type { PersistenceConfig } from './types'

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
    displayKey: xPersistence.displayKey
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
