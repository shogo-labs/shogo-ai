/**
 * Backend Type Definitions
 *
 * This module provides TypeScript types for the backend abstraction layer.
 * It defines the IBackend interface for pluggable execution strategies and
 * supporting types for query options, results, and capability declaration.
 *
 * @module query/backends/types
 *
 * Requirements:
 * - REQ-03: Backend abstraction with pluggable execution strategies
 * - Backend capability declaration for operator availability checks
 *
 * Design decisions:
 * - IBackend interface with generic execute<T>() method
 * - BackendCapabilities for runtime feature detection
 * - QueryOptions for pagination, sorting, and relation loading
 * - QueryResult<T> with optional metadata (totalCount, hasMore)
 * - Types-only module with no runtime dependencies
 */

import type { Condition } from '../ast/types'
import type { ISqlExecutor } from '../execution/types'
import { IQueryExecutor } from '../executors'

// ============================================================================
// DDL Execution Types
// ============================================================================

/**
 * Options for DDL generation.
 */
export interface DDLGenerationOptions {
  /** Use IF NOT EXISTS clause for tables/constraints */
  ifNotExists?: boolean
  /** SQL namespace for table isolation (derived from schema name) */
  namespace?: string
}

/**
 * Result of DDL execution.
 */
export interface DDLExecutionResult {
  /** Whether execution succeeded */
  success: boolean
  /** SQL statements generated */
  statements: string[]
  /** Number of statements executed */
  executed: number
  /** Error message if execution failed */
  error?: string
}

// ============================================================================
// Backend Capabilities
// ============================================================================

/**
 * Declares the operators and features supported by a backend implementation.
 *
 * @remarks
 * Used for runtime capability checking before executing queries.
 * Enables query optimizer to validate operator availability and
 * choose appropriate execution strategy.
 *
 * @example
 * ```typescript
 * const capabilities: BackendCapabilities = {
 *   operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'],
 *   features: {
 *     sorting: true,
 *     pagination: true,
 *     relations: false
 *   }
 * }
 * ```
 */
export type BackendCapabilities = {
  /**
   * List of supported operator names.
   * Operators from @ucast/core: eq, ne, gt, gte, lt, lte, in, nin, regex, etc.
   */
  operators: string[]

  /**
   * Optional feature flags for backend-specific capabilities.
   * Common features: sorting, pagination, relations, aggregation.
   * Values can be boolean (supported/not) or string (capability level).
   */
  features: Record<string, boolean | string>
}

// ============================================================================
// Query Options
// ============================================================================

/**
 * Sorting clause specifying field and direction.
 *
 * @example
 * ```typescript
 * const orderBy: OrderByClause = {
 *   field: 'createdAt',
 *   direction: 'desc'
 * }
 * ```
 */
export type OrderByClause = {
  /** Field name to sort by */
  field: string

  /** Sort direction */
  direction: 'asc' | 'desc'
}

/**
 * Optional parameters for query execution.
 *
 * @remarks
 * Provides pagination, sorting, and relation loading options.
 * Not all backends support all options - check backend.capabilities.
 *
 * @example
 * ```typescript
 * const options: QueryOptions = {
 *   orderBy: { field: 'createdAt', direction: 'desc' },
 *   skip: 20,
 *   take: 10,
 *   include: ['author', 'comments']
 * }
 * ```
 */
export type QueryOptions = {
  /**
   * Sorting specification.
   * Single clause or array for multi-field sorting.
   */
  orderBy?: OrderByClause | OrderByClause[]

  /**
   * Number of records to skip (pagination offset).
   */
  skip?: number

  /**
   * Maximum number of records to return (page size).
   */
  take?: number

  /**
   * Relation names to include (eager loading).
   * Behavior depends on backend implementation.
   */
  include?: string[]
}

// ============================================================================
// Query Result
// ============================================================================

/**
 * Result of a query execution with optional pagination metadata.
 *
 * @remarks
 * Generic type T represents the entity type being queried.
 * Optional metadata fields support pagination and infinite scroll UIs.
 *
 * @example
 * ```typescript
 * const result: QueryResult<User> = {
 *   items: [
 *     { id: '1', name: 'Alice' },
 *     { id: '2', name: 'Bob' }
 *   ],
 *   totalCount: 100,
 *   hasMore: true
 * }
 * ```
 */
export type QueryResult<T> = {
  /**
   * Array of entities matching the query.
   */
  items: T[]

  /**
   * Total count of matching entities (before pagination).
   * Optional - not all backends can efficiently compute total count.
   */
  totalCount?: number

  /**
   * Whether more results exist beyond current page.
   * Used for infinite scroll / "load more" UIs.
   */
  hasMore?: boolean
}

// ============================================================================
// Backend Interface
// ============================================================================

/**
 * Interface for pluggable query execution backends.
 *
 * @remarks
 * Implementations can target different execution environments:
 * - InMemoryBackend: Array.filter() for local collections
 * - MongoBackend: MongoDB query compilation
 * - SQLBackend: SQL query compilation
 * - RemoteBackend: HTTP API calls
 *
 * The execute method is generic to maintain type safety across the pipeline.
 * Capability declaration enables runtime operator availability checking.
 *
 * @example
 * ```typescript
 * class InMemoryBackend implements IBackend {
 *   capabilities: BackendCapabilities = {
 *     operators: ['eq', 'ne', 'gt', 'lt', 'in'],
 *     features: { sorting: true, pagination: true }
 *   }
 *
 *   async execute<T>(
 *     ast: Condition,
 *     collection: T[],
 *     options?: QueryOptions
 *   ): Promise<QueryResult<T>> {
 *     // Execute query against in-memory collection
 *     const items = collection.filter(item => matchesCondition(item, ast))
 *     return { items }
 *   }
 * }
 * ```
 */
export interface IBackend {
  /**
   * Declares the operators and features supported by this backend.
   * Used for runtime capability checking before query execution.
   */
  capabilities: BackendCapabilities

  /**
   * Execute a query against a collection.
   *
   * @param ast - Query AST (parsed from QueryFilter)
   * @param collection - Source collection to query
   * @param options - Optional query options (pagination, sorting, etc.)
   * @returns Promise resolving to query results
   *
   * @remarks
   * Generic type parameter T maintains type safety through the pipeline:
   * - Input: T[] collection
   * - Output: QueryResult<T> with items: T[]
   *
   * Implementations should check capabilities before executing queries
   * with unsupported operators or features.
   */
  execute<T>(
    ast: Condition,
    collection: T[],
    options?: QueryOptions
  ): Promise<QueryResult<T>>

  /**
   * Optional: SQL dialect for SQL-based backends.
   * When present, indicates this is a SQL backend (not memory).
   * Used by BackendRegistry to discriminate backend type.
   */
  dialect?: 'pg' | 'sqlite'

  /**
   * Optional: SQL executor for SQL-based backends.
   * Required when dialect is present.
   * Used by BackendRegistry to create SqlQueryExecutor.
   */
  executor?: ISqlExecutor

  /**
   * Optional: Create a query executor for the given schema and model.
   * Create a query executor for the given schema and model.
   * Used by BackendRegistry to create SqlQueryExecutor.
   */
  createExecutor?<T>(schemaName: string, modelName: string, collection: any): IQueryExecutor<T>

  /**
   * Optional: Execute DDL statements against this backend.
   *
   * @param schema - Enhanced JSON Schema to create tables from
   * @param options - DDL generation options (ifNotExists, etc.)
   * @returns Promise resolving to execution result
   *
   * @remarks
   * - SQL backends: Generate DDL using backend's dialect, execute via executor
   * - Memory backends: No-op (returns success immediately, no tables to create)
   */
  executeDDL?(schema: any, options?: DDLGenerationOptions): Promise<DDLExecutionResult>
}
