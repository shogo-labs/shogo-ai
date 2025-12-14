/**
 * Query Module - Top-Level Barrel Exports
 *
 * Provides a unified entry point for the entire query subsystem, including:
 * - AST types and parsing (query/ast)
 * - Backend abstraction (query/backends)
 * - Schema validation (query/validation)
 * - Backend registry (query/registry)
 *
 * @module query
 *
 * Requirements:
 * - REQ-01: IQueryable interface for chainable queries
 * - REQ-02: MongoDB-style operators
 * - REQ-03: Backend abstraction with pluggable execution
 * - REQ-04: Schema-driven backend binding
 * - REQ-05: Schema-aware validation
 * - REQ-06: Isomorphic execution (browser + server)
 * - REQ-07: MST integration via CollectionQueryable
 *
 * @example
 * ```typescript
 * // Import from top-level query module
 * import {
 *   // AST
 *   parseQuery,
 *   serializeCondition,
 *   type QueryFilter,
 *   // Backends
 *   MemoryBackend,
 *   SqlBackend,
 *   type IBackend,
 *   // Registry
 *   createBackendRegistry,
 *   type IBackendRegistry,
 *   // Validation
 *   QueryValidator,
 *   type IQueryValidator
 * } from '@shogo/state-api/query'
 *
 * // Create backend registry
 * const registry = createBackendRegistry({
 *   default: 'memory',
 *   backends: {
 *     memory: new MemoryBackend()
 *   }
 * })
 *
 * // Parse and execute query
 * const ast = parseQuery({ status: 'active' })
 * const backend = registry.resolve('my-schema', 'Task')
 * const results = await backend.execute(ast, collection)
 * ```
 */

// ============================================================================
// AST Exports (query/ast)
// ============================================================================

/**
 * Query AST types, parsing, operators, and serialization.
 * Re-exported from ./ast
 */
export type {
  // Types
  QueryFilter,
  OperatorExpression,
  LogicalExpression,
  SerializedCondition
} from './ast/types'

export {
  // Parser
  parseQuery,
  createQueryParser,
  defaultParser,
  // Operators
  containsInstruction,
  getCustomParsingInstructions,
  registerCustomOperator,
  // Serialization
  serializeCondition,
  deserializeCondition,
  // AST Classes
  Condition,
  FieldCondition,
  CompoundCondition
} from './ast'

export type { CreateQueryParserOptions } from './ast/parser'

// ============================================================================
// Backend Exports (query/backends)
// ============================================================================

/**
 * Backend abstraction layer with pluggable execution strategies.
 * Re-exported from ./backends
 */
export type {
  IBackend,
  BackendCapabilities,
  QueryOptions,
  QueryResult,
  OrderByClause
} from './backends/types'

export {
  MemoryBackend
} from './backends/memory'

export {
  SqlBackend
} from './backends/sql'

// ============================================================================
// Registry Exports (query/registry)
// ============================================================================

/**
 * Backend registry for schema-driven backend resolution.
 * Re-exported from ./registry
 */
export type {
  IBackendRegistry,
  BackendRegistryConfig
} from './registry'

export {
  BackendRegistry,
  createBackendRegistry
} from './registry'

// ============================================================================
// Validation Exports (query/validation)
// ============================================================================

/**
 * Schema-aware query validation.
 * Re-exported from ./validation
 */
export type {
  IQueryValidator,
  ValidationResult,
  ValidationError,
  ValidationErrorCode
} from './validation/types'

export {
  OPERATOR_BY_TYPE
} from './validation/types'

export {
  QueryValidator
} from './validation/validator'
