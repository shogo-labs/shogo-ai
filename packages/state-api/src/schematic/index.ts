/**
 * Schematic - ArkType to MobX-State-Tree converter
 * 
 * Main entry point for the schematic conversion pipeline
 */

import { type Scope } from "arktype"
import { arkTypeToEnhancedJsonSchema } from "./arktype-to-json-schema"
import { enhancedJsonSchemaToMST, type MSTConversionOptions } from "./enhanced-json-schema-to-mst"

/**
 * Creates an MST store from an arkType scope or multi-domain input
 * 
 * This is the main entry point that combines the two-step process:
 * 1. Convert arkType to enhanced JSON Schema
 * 2. Convert enhanced JSON Schema to MST
 */
export function createStoreFromScope(
  scope: Scope<any> | Record<string, Scope<any>>,
  options?: MSTConversionOptions
) {
  // Step 1: Convert arkType to enhanced JSON Schema
  const enhancedSchema = arkTypeToEnhancedJsonSchema(scope)

  // Step 2: Convert to MST with arkType scope(s) for validation
  const result = enhancedJsonSchemaToMST(enhancedSchema, {
    ...options,
    arkTypeScope: scope
  })

  // Return the full result for compatibility with tests
  return result
}

// Re-export the individual converters for advanced usage
export { arkTypeToEnhancedJsonSchema } from "./arktype-to-json-schema"
export { enhancedJsonSchemaToMST } from "./enhanced-json-schema-to-mst"
export type { EnhancedJsonSchema } from "./types"
export type { MSTConversionResult } from "./enhanced-json-schema-to-mst"