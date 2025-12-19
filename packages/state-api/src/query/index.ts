/**
 * Query Module - Top-Level Barrel Exports
 *
 * Provides a unified entry point for the entire query subsystem, including:
 * - AST types and parsing (query/ast)
 * - Backend abstraction (query/backends)
 * - Schema validation (query/validation)
 * - Backend registry (query/registry)
 * - Database execution (query/execution)
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
 * - REQ-08: Database execution layer via ISqlExecutor
 * - REQ-12: PostgreSQL queryable implementation
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
 *   PostgresBackend,
 *   type IBackend,
 *   // Registry
 *   createBackendRegistry,
 *   type IBackendRegistry,
 *   // Validation
 *   QueryValidator,
 *   type IQueryValidator,
 *   // Execution
 *   BunSqlExecutor,
 *   type ISqlExecutor,
 *   snakeToCamel,
 *   normalizeRows
 * } from '@shogo/state-api/query'
 *
 * // Create backend registry with PostgreSQL
 * const sql = Database.open(':memory:')
 * const executor = new BunSqlExecutor(sql)
 * const postgresBackend = new PostgresBackend(executor)
 *
 * const registry = createBackendRegistry({
 *   default: 'postgres',
 *   backends: {
 *     memory: new MemoryBackend(),
 *     postgres: postgresBackend
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

export {
  PostgresBackend
} from './backends/postgres'

// ============================================================================
// Executor Exports (query/executors)
// ============================================================================

/**
 * Query executors for collections.
 * Re-exported from ./executors
 */
export type {
  IQueryExecutor
} from './executors'

export {
  MemoryQueryExecutor,
  SqlQueryExecutor
} from './executors'

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
  QueryValidationResult,
  ValidationError,
  ValidationErrorCode
} from './validation/types'

export {
  OPERATOR_BY_TYPE
} from './validation/types'

export {
  QueryValidator
} from './validation/validator'

// ============================================================================
// Execution Exports (query/execution)
// ============================================================================

/**
 * Database execution layer with SQL executor interface and utilities.
 * Re-exported from ./execution
 *
 * NOTE: Server-only executors (BunSqlExecutor, BunPostgresExecutor) are NOT
 * exported from this barrel file to avoid bundling Bun-specific code in
 * browser builds. Import them directly when needed:
 *
 * ```typescript
 * // Server-only imports (not exported from main barrel)
 * import { BunSqlExecutor } from '@shogo/state-api/query/execution/bun-sql'
 * import { BunPostgresExecutor } from '@shogo/state-api/query/execution/bun-postgres'
 * ```
 */
export type {
  ISqlExecutor,
  ITransactionExecutor,
  SqlExecutorConfig,
  Row
} from './execution/types'

// NOTE: BunSqlExecutor and BunPostgresExecutor are intentionally NOT exported
// here to prevent them from being bundled in browser builds. They use Bun-only
// APIs (bun:sql, Bun.SQL) that cause "Bun is not defined" errors in browsers.
// Import directly from subpath when needed in server code.

export {
  snakeToCamel,
  camelToSnake,
  normalizeRow,
  normalizeRows
} from './execution/utils'
