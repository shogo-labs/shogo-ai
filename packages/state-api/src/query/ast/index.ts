/**
 * Query AST Module - Barrel Exports
 *
 * This module provides a unified entry point for all query AST functionality.
 * It re-exports types, parsers, operators, serialization utilities, and core AST classes.
 *
 * @module query/ast
 *
 * Requirements:
 * - REQ-02: MongoDB-style operators support
 * - AST-01: All comparison operators
 * - AST-02: Logical operators with arbitrary nesting
 * - AST-03: JSON-serializable for MCP transport
 * - AST-04: TypeScript types for static analysis
 * - AST-05: Extensible for future operators
 *
 * @example
 * ```typescript
 * // Import everything from a single entry point
 * import {
 *   // Types
 *   QueryFilter,
 *   OperatorExpression,
 *   LogicalExpression,
 *   SerializedCondition,
 *   // Parser
 *   parseQuery,
 *   createQueryParser,
 *   defaultParser,
 *   // Operators
 *   containsInstruction,
 *   getCustomParsingInstructions,
 *   registerCustomOperator,
 *   // Serialization
 *   serializeCondition,
 *   deserializeCondition,
 *   // AST Classes
 *   Condition,
 *   FieldCondition,
 *   CompoundCondition
 * } from './query/ast'
 *
 * // Parse a query
 * const ast = parseQuery({ age: { $gt: 18 } })
 *
 * // Serialize for transport
 * const serialized = serializeCondition(ast)
 *
 * // Deserialize back to AST
 * const restored = deserializeCondition(serialized)
 * ```
 */

// ============================================================================
// Type Exports
// ============================================================================

/**
 * MongoDB-style query filter types.
 * Re-exported from ./types
 */
export type {
  QueryFilter,
  OperatorExpression,
  LogicalExpression,
  SerializedCondition,
  // Subquery types
  SubqueryExpression,
  InOperatorValue,
  SerializedSubquery,
  SubqueryCondition
} from './types'

export { isSubqueryExpression } from './types'

// ============================================================================
// Parser Exports
// ============================================================================

/**
 * Parser functions and instances.
 * Re-exported from ./parser
 */
export {
  parseQuery,
  createQueryParser,
  defaultParser
} from './parser'

export type { CreateQueryParserOptions } from './parser'

// ============================================================================
// Operator Exports
// ============================================================================

/**
 * Custom operator utilities.
 * Re-exported from ./operators
 */
export {
  containsInstruction,
  getCustomParsingInstructions,
  registerCustomOperator
} from './operators'

// ============================================================================
// Serialization Exports
// ============================================================================

/**
 * Serialization and deserialization functions.
 * Re-exported from ./serialization
 */
export {
  serializeCondition,
  deserializeCondition
} from './serialization'

// ============================================================================
// AST Class Exports
// ============================================================================

/**
 * Core AST classes from @ucast/core.
 * Re-exported from ./types (which re-exports from @ucast/core)
 */
export {
  Condition,
  FieldCondition,
  CompoundCondition
} from './types'
