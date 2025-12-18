/**
 * DDL utility functions
 *
 * This module provides utility functions for DDL generation:
 * - Topological sorting for table dependency ordering
 * - String conversion utilities (PascalCase/camelCase to snake_case)
 *
 * @module ddl/utils
 */

/**
 * Performs topological sort on models based on foreign key dependencies
 *
 * Returns model names in dependency order where tables with no FK dependencies
 * appear first, ensuring safe creation order. Self-referential FKs are allowed
 * and do not affect ordering. Circular dependencies (excluding self-refs) are
 * detected and result in an error.
 *
 * @param {Record<string, any>} models - Enhanced JSON Schema models keyed by name
 * @returns {string[]} Model names in topologically sorted order
 * @throws {Error} If circular dependencies are detected (excluding self-references)
 *
 * @example
 * ```ts
 * const models = {
 *   Organization: { properties: { id: {...} } },
 *   Team: { properties: { id: {...}, organizationId: { "x-reference-target": "Organization" } } }
 * }
 * const order = topologicalSort(models) // ["Organization", "Team"]
 * ```
 */
export function topologicalSort(models: Record<string, any>): string[] {
  const modelNames = Object.keys(models)
  const graph = new Map<string, Set<string>>() // model -> dependencies
  const visited = new Set<string>()
  const recursionStack = new Set<string>()
  const result: string[] = []

  // Build dependency graph
  for (const modelName of modelNames) {
    const dependencies = new Set<string>()
    const model = models[modelName]

    if (model.properties) {
      for (const propName in model.properties) {
        const prop = model.properties[propName]

        // Check for single references (FK dependencies)
        if (
          prop["x-reference-type"] === "single" &&
          prop["x-reference-target"]
        ) {
          const target = prop["x-reference-target"]

          // Exclude self-references from dependency graph
          if (target !== modelName) {
            dependencies.add(target)
          }
        }
      }
    }

    graph.set(modelName, dependencies)
  }

  // Depth-first search with cycle detection
  function visit(modelName: string, path: string[] = []): void {
    if (recursionStack.has(modelName)) {
      // Circular dependency detected
      const cycle = [...path, modelName]
      throw new Error(
        `Circular dependency detected: ${cycle.join(" -> ")}`
      )
    }

    if (visited.has(modelName)) {
      return // Already processed
    }

    recursionStack.add(modelName)

    const dependencies = graph.get(modelName) || new Set()
    for (const dep of Array.from(dependencies)) {
      if (!modelNames.includes(dep)) {
        // Reference to non-existent model - skip (validation elsewhere)
        continue
      }
      visit(dep, [...path, modelName])
    }

    recursionStack.delete(modelName)
    visited.add(modelName)
    result.push(modelName)
  }

  // Visit all models
  for (const modelName of modelNames) {
    if (!visited.has(modelName)) {
      visit(modelName)
    }
  }

  return result
}

/**
 * Converts PascalCase or camelCase strings to snake_case
 *
 * Used for converting model/property names to database column names.
 * Handles consecutive capitals (e.g., "HTTPSConnection" -> "https_connection").
 *
 * @param {string} str - Input string in PascalCase or camelCase
 * @returns {string} String converted to snake_case
 *
 * @example
 * ```ts
 * toSnakeCase("Organization")      // "organization"
 * toSnakeCase("TeamMember")        // "team_member"
 * toSnakeCase("organizationId")    // "organization_id"
 * toSnakeCase("HTTPSConnection")   // "https_connection"
 * ```
 */
export function toSnakeCase(str: string): string {
  return str
    // Insert underscore before uppercase letters that follow lowercase letters
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    // Insert underscore before uppercase letters followed by lowercase letters (handles consecutive caps)
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    // Convert to lowercase
    .toLowerCase()
}

/**
 * Computes the SQL column name for a property based on its reference metadata.
 *
 * This is the single source of truth for column naming, used by:
 * - DDL generator (constraint-builder.ts)
 * - Meta-store Property.columnName view
 * - Column property map computation
 *
 * Naming convention:
 * - Regular properties: snake_case of property name
 * - Single references: snake_case(target) + "_id"
 * - Array references: snake_case of property name (FKs in junction tables)
 *
 * @param propName - Property name (e.g., "organizationId", "parentId")
 * @param xReferenceTarget - Target model name if reference (e.g., "Organization", "Team")
 * @param xReferenceType - Reference type: "single", "array", or undefined
 * @returns SQL column name (e.g., "organization_id", "team_id", "first_name")
 *
 * @example
 * ```ts
 * getColumnName("firstName")                           // "first_name"
 * getColumnName("organization", "Organization", "single") // "organization_id"
 * getColumnName("parentId", "Team", "single")          // "team_id" (NOT parent_id!)
 * getColumnName("members", "User", "array")            // "members"
 * ```
 */
export function getColumnName(
  propName: string,
  xReferenceTarget?: string,
  xReferenceType?: string
): string {
  // Single references use target_id convention
  // This ensures consistent FK column naming regardless of property name
  if (xReferenceType === "single" && xReferenceTarget) {
    return toSnakeCase(xReferenceTarget) + "_id"
  }

  // Regular properties and array references use snake_case of property name
  return toSnakeCase(propName)
}

/**
 * Computes column → property mappings for all models in an Enhanced JSON Schema.
 *
 * Returns a nested map: { ModelName: { column_name: "propertyName", ... }, ... }
 *
 * Used by domain() to pre-compute mappings that enable createStore() to work
 * with SQL backends without requiring meta-store registration.
 *
 * @param schema - Enhanced JSON Schema with $defs or definitions
 * @returns Record mapping model names to their column→property maps
 *
 * @example
 * ```ts
 * const schema = {
 *   $defs: {
 *     Team: {
 *       properties: {
 *         id: { type: "string" },
 *         organizationId: { "x-reference-type": "single", "x-reference-target": "Organization" },
 *         parentId: { "x-reference-type": "single", "x-reference-target": "Team" }
 *       }
 *     }
 *   }
 * }
 *
 * const maps = computeColumnPropertyMaps(schema)
 * // maps.Team = { id: "id", organization_id: "organizationId", team_id: "parentId" }
 * ```
 */
export function computeColumnPropertyMaps(
  schema: any
): Record<string, Record<string, string>> {
  const models = schema.$defs || schema.definitions || {}
  const result: Record<string, Record<string, string>> = {}

  for (const [modelName, modelDef] of Object.entries(models)) {
    const model = modelDef as any
    const columnPropertyMap: Record<string, string> = {}

    if (model.properties) {
      for (const [propName, propDef] of Object.entries(model.properties)) {
        const prop = propDef as any

        // Compute column name using the canonical helper
        const columnName = getColumnName(
          propName,
          prop["x-reference-target"],
          prop["x-reference-type"]
        )

        // Map: column_name → propertyName
        columnPropertyMap[columnName] = propName
      }
    }

    result[modelName] = columnPropertyMap
  }

  return result
}
