/**
 * Type Resolution Helpers for Enhanced JSON Schema to MST Conversion
 *
 * Contains functions for resolving JSON Schema types to MST types.
 * Split from enhanced-json-schema-to-mst.ts for esbuild compatibility.
 */

import { types } from "mobx-state-tree"

/**
 * Extracts target model name from arkType string
 */
export function extractTargetModel(arkType?: string): string {
  if (!arkType) return ""
  // Remove array brackets and domain prefix if present
  return arkType.replace("[]", "").split(".").pop() || ""
}

// ============================================================================
// Forward Declarations for Mutual Recursion
// ============================================================================
/**
 * IMPORTANT: This pattern is required for esbuild/Sandpack compatibility.
 *
 * These functions are mutually recursive:
 * - resolveTypeDefinition calls resolvePropertyType (for array items, nested objects)
 * - resolvePropertyType calls resolveTypeDefinition (for $ref resolution)
 *
 * In standard JavaScript/TypeScript, you can define mutually recursive functions
 * with standard `function` declarations because they're hoisted. However, esbuild's
 * tree-shaking and module bundling can fail with this pattern when the functions
 * are in the same module but reference each other before their definitions are
 * processed.
 *
 * The `let` + assignment pattern ensures:
 * 1. Both variable declarations are hoisted
 * 2. Both functions exist as callable values before either is invoked
 * 3. esbuild can correctly analyze and bundle the module
 *
 * DO NOT refactor to standard `function` declarations without testing in the
 * Sandpack environment, as it may cause "function is not defined" errors at runtime.
 *
 * @see https://esbuild.github.io/content-types/#direct-eval - related bundler issues
 */
let resolveTypeDefinitionImpl: (def: any, allDefs: Record<string, any>, visited: Set<string>) => any
let resolvePropertyTypeImpl: (propName: string, propSchema: any, allDefs: Record<string, any>, visited: Set<string>) => any

/**
 * Resolves a type definition to MST type
 */
resolveTypeDefinitionImpl = function(
  def: any,
  allDefs: Record<string, any>,
  visited: Set<string>
): any {
  // Handle 'unknown' type or empty definition (for JSON Schema default values that can be any type)
  // This is used by meta-store Property entity for const/default fields
  // An empty {} in JSON Schema means "any value" which MST represents as frozen()
  if (Object.keys(def).length === 0 || def["x-arktype"] === "unknown") {
    return types.frozen()
  }

  // Arrays
  if (def.type === "array") {
    // Handle regular arrays with items
    if (def.items && def.items !== false) {
      const itemType = def.items.$ref
        ? resolvePropertyTypeImpl("item", def.items, allDefs, new Set(visited))
        : resolveTypeDefinitionImpl(def.items, allDefs, new Set(visited))
      return types.optional(types.array(itemType), [])
    }
    // Handle tuple-like arrays with prefixItems
    else if (def.prefixItems && def.prefixItems.length > 0) {
      // Use the first prefixItem as the array item type
      const itemType = resolveTypeDefinitionImpl(def.prefixItems[0], allDefs, new Set(visited))
      return types.optional(types.array(itemType), [])
    }
    // Default to array of any
    return types.optional(types.array(types.frozen()), [])
  }

  // Nested objects
  if (def.type === "object" && def.properties) {
    const props: Record<string, any> = {}
    const required = new Set(def.required || [])

    for (const [key, value] of Object.entries(def.properties)) {
      const propType = resolvePropertyTypeImpl(key, value as any, allDefs, new Set(visited))
      props[key] = required.has(key) ? propType : types.maybe(propType)
    }

    return types.model(props)
  }

  // Opaque objects (type: object, no properties)
  if (def.type === "object" && !def.properties) {
    return types.frozen()
  }

  // Primitives
  switch (def.type) {
    case "string":
      // Add validation if we have constraints
      if (def.minLength !== undefined) {
        return types.refinement(types.string, value => value.length >= def.minLength)
      }
      return types.string

    case "number":
    case "integer":  // JSON Schema integer type (whole numbers) - treat as MST number
      // Add validation if we have constraints
      if (def.minimum !== undefined) {
        return types.refinement(types.number, value => value >= def.minimum)
      }
      return types.number

    case "boolean":
      return types.boolean
  }

  // Handle 'unknown' type (for JSON Schema default values that can be any type)
  // This is used by meta-store Property entity for const/default fields
  // Check both x-arktype annotation and absence of type (JSON Schema for 'any' value)
  if (def["x-arktype"] === "unknown" || def.type === undefined) {
    return types.frozen()
  }

  // Special handling for UUID
  if (def.anyOf && def.format === "uuid") {
    return types.refinement(types.string, value => {
      // Simple UUID validation
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    })
  }

  // Enums
  if (def.enum) {
    return types.enumeration(def.enum)
  }

  return types.string // Default
}

/**
 * Resolves a property schema to MST type
 */
resolvePropertyTypeImpl = function(
  propName: string,
  propSchema: any,
  allDefs: Record<string, any>,
  visited: Set<string>
): any {
  // Handle identifier - check multiple conditions
  if (propSchema["x-mst-type"] === "identifier" ||
    propName === "id" ||
    propName.toLowerCase() === "id" ||
    (propSchema["x-arktype"] && propSchema["x-arktype"].includes("uuid"))) {
    return types.identifier
  }

  // Resolve $ref if present
  if (propSchema.$ref) {
    const refName = propSchema.$ref.replace("#/$defs/", "")

    // Prevent infinite recursion
    if (visited.has(refName)) {
      // This is an entity reference that wasn't marked as such
      return types.string // Just use string for the ID
    }

    visited.add(refName)
    const refDef = allDefs[refName]
    if (refDef) {
      // Special handling for UUID types that arktype generates
      if (refDef.anyOf && refDef.format === "uuid") {
        return types.refinement(types.string, value => {
          // Simple UUID validation
          return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        })
      }
      return resolveTypeDefinitionImpl(refDef, allDefs, visited)
    }
    // If ref not found, it might be a type ref (e.g., string.email)
    // Fall through to handle the property itself
  }

  return resolveTypeDefinitionImpl(propSchema, allDefs, visited)
}

// Export the implementations with clean names
export const resolveTypeDefinition = resolveTypeDefinitionImpl
export const resolvePropertyType = resolvePropertyTypeImpl
