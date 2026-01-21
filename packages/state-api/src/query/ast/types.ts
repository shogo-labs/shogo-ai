/**
 * Query AST Type Definitions
 *
 * This module provides foundational TypeScript types for the query AST system.
 * It re-exports core @ucast/core types and defines MongoDB-style query filter types.
 *
 * @module query/ast/types
 *
 * Requirements:
 * - AST-04: TypeScript types for static analysis
 * - REQ-02: MongoDB-style operators support
 *
 * Design decisions:
 * - Re-export @ucast/core types for AST representation
 * - Define MongoDB-style types for query input (QueryFilter, OperatorExpression, LogicalExpression)
 * - Define SerializedCondition for JSON-safe AST transport over MCP
 * - Types-only module with no runtime dependencies
 */

// ============================================================================
// Re-exports from @ucast/core
// ============================================================================

// Import for local use (as type)
import type { Condition as UcastCondition } from '@ucast/core'

/**
 * Base class for all AST condition nodes.
 * Can be either a FieldCondition or CompoundCondition.
 *
 * @remarks
 * Condition is an abstract class from @ucast/core that all condition types extend.
 * Use `Condition` as a type for function parameters/returns that accept any condition.
 */
export { Condition } from '@ucast/core'

/**
 * Type alias for Condition class to use in type positions.
 */
export type { Condition as ConditionType } from '@ucast/core'

/**
 * AST node representing a field-level condition (e.g., { status: 'active' }).
 * Contains operator, field, and value.
 */
export { FieldCondition } from '@ucast/core'

/**
 * AST node representing a compound logical condition (e.g., $and, $or).
 * Contains operator and array of child conditions.
 */
export { CompoundCondition } from '@ucast/core'

// ============================================================================
// MongoDB-Style Query Filter Types
// ============================================================================

/**
 * Expression object containing comparison operators.
 * Represents the right-hand side of a field condition.
 *
 * @example
 * ```typescript
 * const expr: OperatorExpression = { $gt: 18 }
 * const filter = { age: expr } // { age: { $gt: 18 } }
 * ```
 *
 * Supported operators:
 * - Equality: $eq, $ne
 * - Comparison: $gt, $gte, $lt, $lte
 * - Array: $in, $nin
 * - String: $regex, $contains
 */
export type OperatorExpression = {
  /** Equality: field equals value */
  $eq?: any
  /** Not equal: field does not equal value */
  $ne?: any
  /** Greater than: field > value */
  $gt?: any
  /** Greater than or equal: field >= value */
  $gte?: any
  /** Less than: field < value */
  $lt?: any
  /** Less than or equal: field <= value */
  $lte?: any
  /** In array: field value is in array */
  $in?: any[]
  /** Not in array: field value is not in array */
  $nin?: any[]
  /** Regular expression: field matches pattern (string or RegExp) */
  $regex?: string | RegExp
  /** Contains: field contains value (string substring or array element) */
  $contains?: any
}

/**
 * Logical operators for combining multiple conditions.
 *
 * @example
 * ```typescript
 * const expr: LogicalExpression = {
 *   $or: [
 *     { status: 'active' },
 *     { featured: true }
 *   ]
 * }
 * ```
 */
export type LogicalExpression =
  | { $and: QueryFilter[] }
  | { $or: QueryFilter[] }
  | { $not: QueryFilter }

/**
 * MongoDB-style query filter object.
 * Can be field conditions, operator expressions, or logical expressions.
 *
 * @example
 * ```typescript
 * // Simple equality
 * const filter1: QueryFilter = { status: 'active' }
 *
 * // Operator expression
 * const filter2: QueryFilter = { age: { $gt: 18 } }
 *
 * // Logical expression
 * const filter3: QueryFilter = {
 *   $and: [
 *     { category: 'electronics' },
 *     { $or: [{ price: { $lt: 100 } }, { onSale: true }] }
 *   ]
 * }
 * ```
 */
export type QueryFilter =
  | { [field: string]: any | OperatorExpression }
  | LogicalExpression

// ============================================================================
// Serialized AST Types (JSON-Safe)
// ============================================================================

/**
 * JSON-safe serialized representation of a Condition AST node.
 * Used for transporting AST over MCP (Model Context Protocol).
 *
 * Differences from runtime Condition:
 * - RegExp values are serialized as { $regex: string, $options: string }
 * - Includes explicit 'type' discriminator for deserialization
 * - All values are JSON-serializable primitives
 *
 * @example
 * ```typescript
 * // Field condition
 * const serialized: SerializedCondition = {
 *   type: 'field',
 *   operator: 'eq',
 *   field: 'status',
 *   value: 'active'
 * }
 *
 * // Compound condition
 * const serialized: SerializedCondition = {
 *   type: 'compound',
 *   operator: 'and',
 *   value: [
 *     { type: 'field', operator: 'eq', field: 'a', value: 1 },
 *     { type: 'field', operator: 'eq', field: 'b', value: 2 }
 *   ]
 * }
 *
 * // RegExp serialization
 * const serialized: SerializedCondition = {
 *   type: 'field',
 *   operator: 'regex',
 *   field: 'email',
 *   value: { $regex: '@example\\.com$', $options: 'i' }
 * }
 * ```
 */
export type SerializedCondition =
  | {
      type: 'field'
      operator: string
      field: string
      value: any
    }
  | {
      type: 'compound'
      operator: string
      value: SerializedCondition[]
    }
  | {
      type: 'subquery'
      field: string
      operator: 'in' | 'nin'
      subquery: SerializedSubquery
    }

// ============================================================================
// Subquery Types
// ============================================================================

/**
 * Subquery definition for use inside $in operator.
 * Represents a query against another model that returns a set of values.
 *
 * @example
 * ```typescript
 * // Filter posts by admin authors
 * const filter: QueryFilter = {
 *   authorId: {
 *     $in: {
 *       $query: {
 *         model: 'User',
 *         filter: { role: 'admin' }
 *       }
 *     }
 *   }
 * }
 *
 * // Compiles to: WHERE author_id IN (SELECT id FROM users WHERE role = 'admin')
 * ```
 */
export interface SubqueryExpression {
  $query: {
    /** Optional schema name for cross-schema queries (e.g., 'studio-core') */
    schema?: string
    /** Target model name (e.g., 'User', 'Organization') */
    model: string
    /** Optional filter to apply on target model */
    filter?: QueryFilter
    /** Field to select from target model (defaults to 'id') */
    field?: string
  }
}

/**
 * Type guard to check if a value is a SubqueryExpression.
 */
export function isSubqueryExpression(value: unknown): value is SubqueryExpression {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$query' in value &&
    typeof (value as any).$query === 'object' &&
    typeof (value as any).$query.model === 'string'
  )
}

/**
 * Extended $in operator value that accepts either a literal array or a subquery.
 */
export type InOperatorValue = unknown[] | SubqueryExpression

/**
 * Serialized subquery for JSON transport.
 */
export interface SerializedSubquery {
  /** Optional schema name for cross-schema queries */
  schema?: string
  model: string
  filter?: SerializedCondition
  /** Field to select from target model (serialized form uses 'field' not 'selectField') */
  field: string
}

/**
 * Runtime AST node representing a subquery condition.
 * Used internally after parsing a SubqueryExpression.
 *
 * @remarks
 * This is NOT a @ucast/core Condition subclass - it's a custom node type
 * that must be handled specially by backends.
 */
export interface SubqueryCondition {
  /** Discriminator for condition type */
  type: 'subquery'
  /** The outer field being filtered (e.g., 'authorId') */
  field: string
  /** The operator (currently 'in' or 'nin') */
  operator: 'in' | 'nin'
  /** The subquery definition */
  subquery: {
    /** Optional schema name for cross-schema queries (e.g., 'studio-core') */
    schema?: string
    /** Target model to query */
    model: string
    /** Parsed AST filter for target model (undefined = no filter) */
    filter?: ParsedCondition
    /** Field to select from target model */
    selectField: string
  }
}

/**
 * Union type representing any condition AST node.
 *
 * Use this type for function parameters and returns that can accept
 * either a standard @ucast/core Condition or a SubqueryCondition.
 *
 * @example
 * ```typescript
 * function processCondition(ast: ParsedCondition): void {
 *   if ('type' in ast && ast.type === 'subquery') {
 *     // Handle SubqueryCondition
 *   } else {
 *     // Handle Condition
 *   }
 * }
 * ```
 */
export type ParsedCondition = UcastCondition | SubqueryCondition
