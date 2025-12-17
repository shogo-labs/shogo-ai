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
