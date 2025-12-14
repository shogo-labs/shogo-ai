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
}
