/**
 * Query Validation Module
 *
 * Provides schema-aware query validation with operator-type compatibility checking.
 *
 * @module query/validation
 *
 * @example
 * ```typescript
 * import { QueryValidator, OPERATOR_BY_TYPE, type IQueryValidator } from "@shogo/state-api/query/validation"
 *
 * // Create validator
 * const validator = new QueryValidator(metaStore)
 *
 * // Parse and validate query
 * const ast = parser.parse({ age: { $gt: 18 } })
 * const result = validator.validateQuery(ast, "my-schema", "User")
 *
 * if (!result.valid) {
 *   console.error(result.errors)
 * }
 *
 * // Check valid operators for a type
 * console.log(OPERATOR_BY_TYPE.boolean) // ["eq", "ne"]
 * ```
 */

// ============================================================================
// Type Exports
// ============================================================================

export type { IQueryValidator, ValidationResult, ValidationError, ValidationErrorCode } from "./types"
export { OPERATOR_BY_TYPE } from "./types"

// ============================================================================
// Implementation Exports
// ============================================================================

export { QueryValidator } from "./validator"
