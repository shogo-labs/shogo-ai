/**
 * Query Validator Implementation
 *
 * Validates queries against schema definitions using meta-store for property type lookup.
 * Uses lazy memoization for performance optimization.
 *
 * @module query/validation/validator
 *
 * Requirements:
 * - VAL-02: Validate property paths exist in schema
 * - VAL-03: Validate operator compatibility with property type
 * - VAL-04: Isomorphic - same code browser/server
 * - VAL-05: Return actionable error messages
 */

import { FieldCondition, CompoundCondition, type Condition } from "../ast/types"
import { OPERATOR_BY_TYPE, type IQueryValidator, type QueryValidationResult, type ValidationError } from "./types"

// ============================================================================
// Property Type Info (for memoization)
// ============================================================================

interface PropertyTypeInfo {
  type?: string
  format?: string
  $ref?: string
  xReferenceType?: "single" | "array"
}

// ============================================================================
// QueryValidator Implementation
// ============================================================================

/**
 * Validates queries against schema definitions.
 *
 * Uses lazy memoization (Approach C from validation-poc):
 * - Property types are fetched from meta-store on first access
 * - Cached for subsequent validations
 * - Cache can be cleared when schema changes
 *
 * @example
 * ```typescript
 * const metaStore = createMetaStore().createStore({ ... })
 * const validator = new QueryValidator(metaStore)
 *
 * // Validate a query
 * const ast = parser.parse({ age: { $gt: 18 } })
 * const result = validator.validateQuery(ast, "my-schema", "User")
 *
 * if (!result.valid) {
 *   console.error(result.errors)
 * }
 *
 * // Clear cache when schema changes
 * validator.clearCache("my-schema")
 * ```
 */
export class QueryValidator implements IQueryValidator {
  private metaStore: any
  private operatorCache: Map<string, readonly string[] | null> = new Map()

  /**
   * Create a query validator.
   *
   * @param metaStore - Meta-store instance with loaded schemas
   */
  constructor(metaStore: any) {
    this.metaStore = metaStore
  }

  /**
   * Clear the operator cache.
   * Call this when schemas are modified or reloaded.
   *
   * @param schemaName - Optional: Clear only cache entries for this schema
   *
   * @example
   * ```typescript
   * // Clear all cached operators
   * validator.clearCache()
   *
   * // Clear only for specific schema
   * validator.clearCache("my-schema")
   * ```
   */
  clearCache(schemaName?: string): void {
    if (schemaName) {
      // Clear only entries for this schema
      for (const key of this.operatorCache.keys()) {
        if (key.startsWith(`${schemaName}:`)) {
          this.operatorCache.delete(key)
        }
      }
    } else {
      // Clear entire cache
      this.operatorCache.clear()
    }
  }

  /**
   * Get valid operators for a property, with memoization.
   *
   * Returns null if property doesn't exist (for INVALID_PROPERTY errors).
   */
  private getValidOperators(
    schemaName: string,
    modelName: string,
    propertyName: string
  ): readonly string[] | null {
    const cacheKey = `${schemaName}:${modelName}:${propertyName}`

    // Check cache first
    if (this.operatorCache.has(cacheKey)) {
      return this.operatorCache.get(cacheKey)!
    }

    // Lookup property from meta-store
    const property = this.getPropertyFromMetaStore(schemaName, modelName, propertyName)

    if (!property) {
      // Property doesn't exist - cache null
      this.operatorCache.set(cacheKey, null)
      return null
    }

    // Derive operators from property type
    const operators = this.deriveOperatorsForProperty(property)

    // Cache and return
    this.operatorCache.set(cacheKey, operators)
    return operators
  }

  /**
   * Get property type info from meta-store.
   */
  private getPropertyFromMetaStore(
    schemaName: string,
    modelName: string,
    propertyName: string
  ): PropertyTypeInfo | null {
    // Find schema
    const schema = this.metaStore.findSchemaByName(schemaName)
    if (!schema) {
      return null
    }

    // Find model within schema
    const model = schema.models?.find((m: any) => m.name === modelName)
    if (!model) {
      return null
    }

    // Find property within model
    const property = model.properties?.find((p: any) => p.name === propertyName)
    if (!property) {
      return null
    }

    // Extract type info
    return {
      type: property.type,
      format: property.format,
      $ref: property.$ref,
      xReferenceType: property.xReferenceType
    }
  }

  /**
   * Derive valid operators for a property based on its type and format.
   */
  private deriveOperatorsForProperty(property: PropertyTypeInfo): readonly string[] {
    // Reference types (identified by $ref or xReferenceType)
    if (property.$ref || property.xReferenceType) {
      return OPERATOR_BY_TYPE.reference
    }

    // Check format first (e.g., date-time strings)
    if (property.format === "date-time") {
      return OPERATOR_BY_TYPE["date-time"]
    }

    // Fall back to type
    const type = property.type || "object"
    return OPERATOR_BY_TYPE[type] || OPERATOR_BY_TYPE.object
  }

  /**
   * Validate a condition AST recursively.
   */
  private validateCondition(
    schemaName: string,
    modelName: string,
    condition: Condition,
    path: string = ""
  ): ValidationError[] {
    const errors: ValidationError[] = []

    if (condition instanceof FieldCondition) {
      const fieldPath = path ? `${path}.${condition.field}` : condition.field

      // VAL-02: Check property exists
      const validOperators = this.getValidOperators(schemaName, modelName, condition.field)

      if (validOperators === null) {
        errors.push({
          code: "INVALID_PROPERTY",
          message: `Property '${condition.field}' does not exist on model '${modelName}'`,
          path: fieldPath
        })
        return errors
      }

      // VAL-03: Check operator is valid for property type
      if (!validOperators.includes(condition.operator)) {
        const property = this.getPropertyFromMetaStore(schemaName, modelName, condition.field)
        const propertyType = property?.type || "unknown"

        errors.push({
          code: "INVALID_OPERATOR",
          message: `Operator '$${condition.operator}' is not valid for property '${condition.field}' of type '${propertyType}'. Valid operators: ${validOperators.map(op => "$" + op).join(", ")}`,
          path: fieldPath,
          operator: condition.operator,
          propertyType
        })
      }
    } else if (condition instanceof CompoundCondition) {
      // Recursively validate nested conditions
      for (const nested of condition.value) {
        errors.push(...this.validateCondition(schemaName, modelName, nested, path))
      }
    }

    return errors
  }

  /**
   * Validate a query AST against a schema/model.
   *
   * @param ast - Parsed query condition AST
   * @param schemaName - Name of the schema to validate against
   * @param modelName - Name of the model within the schema
   * @returns Validation result with actionable error messages
   *
   * @example
   * ```typescript
   * const parser = new MongoQueryParser({ ... })
   * const ast = parser.parse({ age: { $gt: 18 } })
   * const result = validator.validateQuery(ast, "my-schema", "User")
   *
   * if (!result.valid) {
   *   result.errors.forEach(error => {
   *     console.error(`${error.code} at ${error.path}: ${error.message}`)
   *   })
   * }
   * ```
   */
  validateQuery(ast: Condition, schemaName: string, modelName: string): QueryValidationResult {
    // First check schema exists
    const schema = this.metaStore.findSchemaByName(schemaName)
    if (!schema) {
      return {
        valid: false,
        errors: [
          {
            code: "INVALID_PROPERTY",
            message: `Schema '${schemaName}' does not exist`,
            path: ""
          }
        ]
      }
    }

    // Check model exists
    const model = schema.models?.find((m: any) => m.name === modelName)
    if (!model) {
      return {
        valid: false,
        errors: [
          {
            code: "INVALID_PROPERTY",
            message: `Model '${modelName}' does not exist in schema '${schemaName}'`,
            path: ""
          }
        ]
      }
    }

    // Validate the condition tree
    const errors = this.validateCondition(schemaName, modelName, ast)

    return {
      valid: errors.length === 0,
      errors
    }
  }
}
