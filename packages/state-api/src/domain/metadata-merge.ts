/**
 * Metadata Merge
 *
 * When domain() receives an ArkType scope, this module can merge
 * metadata from .schemas/{name}/schema.json into the generated
 * Enhanced JSON Schema.
 *
 * Design: Accepts an optional loader function for testability.
 * In production, uses loadSchema from persistence/schema-io.
 * In tests, pass a mock loader to avoid filesystem access.
 */

import type { EnhancedJsonSchema } from "../schematic/types"

/**
 * Type for schema loader function (for dependency injection in tests)
 */
export type SchemaLoader = (name: string, workspace?: string) => Promise<{
  metadata: { id: string; name: string; createdAt: number; format: string }
  enhanced: any
}>

/**
 * Default loader - lazy imports from persistence to avoid bundling fs in browser
 */
let defaultLoader: SchemaLoader | null = null

async function getDefaultLoader(): Promise<SchemaLoader | null> {
  if (defaultLoader === null) {
    try {
      const schemaIO = await import("../persistence/schema-io")
      defaultLoader = schemaIO.loadSchema
    } catch {
      // Browser environment - no filesystem access
      defaultLoader = undefined as any
    }
  }
  return defaultLoader
}

/**
 * Merge metadata from schema.json into an Enhanced JSON Schema.
 *
 * Called when domain() receives an ArkType scope. Attempts to load
 * .schemas/{name}/schema.json and merge x-* extensions.
 *
 * @param name - Schema name (folder name in .schemas/)
 * @param schema - Base Enhanced JSON Schema (from ArkType conversion)
 * @param workspace - Optional workspace path
 * @param loader - Optional loader function (for testing - pass mock here)
 * @returns Schema with merged metadata, or original if no file found
 */
export async function mergeMetadataFromFile(
  name: string,
  schema: EnhancedJsonSchema,
  workspace?: string,
  loader?: SchemaLoader
): Promise<EnhancedJsonSchema> {
  // Use provided loader or get default
  const loadFn = loader ?? (await getDefaultLoader())

  // No loader available (browser) - return original
  if (!loadFn) {
    return schema
  }

  try {
    const { enhanced } = await loadFn(name, workspace)

    // Extract root-level x-* extensions from loaded schema
    const extensions: Record<string, any> = {}

    for (const [key, value] of Object.entries(enhanced)) {
      if (key.startsWith("x-") && value !== undefined) {
        extensions[key] = value
      }
    }

    // Also extract views if present
    if (enhanced.views) {
      extensions.views = enhanced.views
    }

    // Merge model-level x-* extensions from $defs
    // This is critical for x-authorization, x-persistence, x-renderer on individual models
    const mergedDefs = { ...(schema.$defs || {}) }
    const fileDefs = enhanced.$defs || {}

    for (const [modelName, fileDef] of Object.entries(fileDefs)) {
      if (!fileDef || typeof fileDef !== 'object') continue

      // Get the base model from converted schema (or create empty)
      const baseDef = mergedDefs[modelName] || {}

      // Extract x-* extensions from file's model definition
      const modelExtensions: Record<string, any> = {}
      for (const [key, value] of Object.entries(fileDef as Record<string, any>)) {
        if (key.startsWith("x-") && value !== undefined) {
          modelExtensions[key] = value
        }
      }

      // Merge: file metadata takes precedence over base
      if (Object.keys(modelExtensions).length > 0) {
        mergedDefs[modelName] = {
          ...baseDef,
          ...modelExtensions,
        }
      }
    }

    // Merge: file metadata takes precedence
    return {
      ...schema,
      ...extensions,
      $defs: mergedDefs,
    }
  } catch (error: any) {
    // ENOENT = file not found - normal case, return original
    if (error.code === "ENOENT") {
      return schema
    }
    // Log other errors but don't fail
    console.warn(`[metadata-merge] Failed to load ${name}/schema.json:`, error.message)
    return schema
  }
}
