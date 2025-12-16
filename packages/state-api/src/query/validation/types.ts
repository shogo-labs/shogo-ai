/**
 * Validation Type Definitions
 *
 * Provides types and constants for schema-aware query validation.
 *
 * @module query/validation/types
 *
 * Requirements:
 * - VAL-01: Derive valid operators from property type
 * - VAL-02: Validate property paths exist in schema
 * - VAL-03: Validate operator compatibility with property type
 * - VAL-05: Return actionable error messages
 */

import type { Condition } from "../ast/types"

// ============================================================================
// Validation Result Types
// ============================================================================

/**
 * Error codes for validation failures.
 */
export type ValidationErrorCode = "INVALID_PROPERTY" | "INVALID_OPERATOR"

/**
 * Validation error with code, message, and path.
 *
 * @example
 * ```typescript
 * const error: ValidationError = {
 *   code: "INVALID_PROPERTY",
 *   message: "Property 'foo' does not exist on model 'User'",
 *   path: "foo"
 * }
 * ```
 */
export interface ValidationError {
  /** Error code identifying the type of validation failure */
  code: ValidationErrorCode
  /** Human-readable error message with actionable information */
  message: string
  /** Path to the problematic field in the query */
  path: string
  /** Optional: The operator that failed validation */
  operator?: string
  /** Optional: The property type that caused the mismatch */
  propertyType?: string
}

/**
 * Result of query validation.
 *
 * @example
 * ```typescript
 * // Valid query
 * const result: QueryValidationResult = {
 *   valid: true,
 *   errors: []
 * }
 *
 * // Invalid query
 * const result: QueryValidationResult = {
 *   valid: false,
 *   errors: [{
 *     code: "INVALID_PROPERTY",
 *     message: "Property 'foo' does not exist",
 *     path: "foo"
 *   }]
 * }
 * ```
 */
export interface QueryValidationResult {
  /** Whether the query passed validation */
  valid: boolean
  /** Array of validation errors (empty if valid) */
  errors: ValidationError[]
}

// ============================================================================
// Query Validator Interface
// ============================================================================

/**
 * Interface for query validators.
 * Validates a parsed Condition AST against a schema/model.
 *
 * @example
 * ```typescript
 * const validator: IQueryValidator = new QueryValidator(metaStore)
 * const result = validator.validateQuery(ast, "my-schema", "User")
 * if (!result.valid) {
 *   console.error(result.errors)
 * }
 * ```
 */
export interface IQueryValidator {
  /**
   * Validate a query AST against a schema/model.
   *
   * @param ast - Parsed query condition AST from @ucast/mongo parser
   * @param schemaName - Name of the schema to validate against
   * @param modelName - Name of the model within the schema
   * @returns Validation result with errors if invalid
   */
  validateQuery(ast: Condition, schemaName: string, modelName: string): QueryValidationResult
}

// ============================================================================
// Operator-Type Compatibility (VAL-01)
// ============================================================================

/**
 * Maps JSON Schema types to valid query operators.
 * This is the core logic for VAL-01 (derive valid operators from property type).
 *
 * @remarks
 * - Operator names match @ucast/mongo operator names (without $ prefix)
 * - Each type's operators reflect MongoDB semantics
 * - Custom operators like $contains are included
 *
 * @example
 * ```typescript
 * const stringOps = OPERATOR_BY_TYPE.string
 * stringOps.includes("eq")      // true
 * stringOps.includes("regex")   // true
 * stringOps.includes("gt")      // true (strings support lexicographic comparison)
 *
 * const booleanOps = OPERATOR_BY_TYPE.boolean
 * booleanOps.includes("eq")     // true
 * booleanOps.includes("gt")     // false (booleans don't support comparison)
 * ```
 */
export const OPERATOR_BY_TYPE: Record<string, readonly string[]> = {
  // String type supports all comparison, equality, set membership, and pattern matching
  string: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "regex", "contains"],

  // Numeric types support all comparison and equality operators
  number: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"],
  integer: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"],

  // Boolean type only supports equality checks
  boolean: ["eq", "ne"],

  // Array type supports containment and set membership
  array: ["in", "nin", "contains"],

  // Object type (generic) supports only equality
  object: ["eq", "ne"],

  // Reference types (MST references) support equality and set membership
  reference: ["eq", "ne", "in", "nin"],

  // Date-time strings support comparison (ISO 8601 lexicographic order)
  "date-time": ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"],
}
