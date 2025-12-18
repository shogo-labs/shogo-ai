/**
 * CollectionQueryable Mixin
 *
 * Adds .query() method to collections, returning an IQueryable builder
 * for chainable LINQ-style queries with async terminal operations.
 *
 * @module composition/queryable
 *
 * Requirements:
 * - REQ-01: IQueryable interface with chainable where/orderBy/skip/take
 * - REQ-07: MST integration via CollectionQueryable mixin
 * - Query builder is immutable (each method returns new instance)
 * - Terminal operations (toArray/first/count/any) are async
 * - Uses getEnv<IEnvironment>(self).services.backendRegistry
 *
 * Usage:
 * ```typescript
 * const MyCollection = types.compose(
 *   BaseCollection,
 *   CollectionQueryable
 * ).named('MyCollection')
 *
 * const collection = MyCollection.create({}, environment)
 * const results = await collection.query()
 *   .where({ status: 'active' })
 *   .orderBy('createdAt', 'desc')
 *   .skip(10)
 *   .take(5)
 *   .toArray()
 * ```
 */

import { types, getEnv } from 'mobx-state-tree'
import type { IEnvironment } from '../environment/types'
import type { QueryFilter } from '../query/ast/types'
import type { OrderByClause } from '../query/backends/types'
import type { IQueryExecutor } from '../query/executors/types'
import { parseQuery } from '../query/ast/parser'

// ============================================================================
// IQueryable Interface
// ============================================================================

/**
 * Chainable query builder interface.
 *
 * @remarks
 * Provides LINQ-style query composition with immutable builder pattern.
 * Each chainable method returns a new instance with updated state.
 * Terminal operations execute the query and return Promise.
 *
 * @example
 * ```typescript
 * const query: IQueryable<User> = collection.query()
 *   .where({ status: 'active' })
 *   .orderBy('name', 'asc')
 *   .skip(20)
 *   .take(10)
 *
 * // Terminal operations
 * const users = await query.toArray()
 * const first = await query.first()
 * const count = await query.count()
 * const hasAny = await query.any()
 * ```
 */
export interface IQueryable<T> {
  /**
   * Add filter conditions to the query.
   *
   * @param filter - MongoDB-style filter object
   * @returns New IQueryable instance with filter applied
   *
   * @remarks
   * Immutable operation - returns new instance, does not modify original.
   * Multiple where() calls are combined with $and logic.
   *
   * @example
   * ```typescript
   * query
   *   .where({ status: 'active' })
   *   .where({ age: { $gte: 18 } })
   * // Equivalent to: { $and: [{ status: 'active' }, { age: { $gte: 18 } }] }
   * ```
   */
  where(filter: QueryFilter): IQueryable<T>

  /**
   * Set sort order for the query.
   *
   * @param field - Field name to sort by
   * @param direction - Sort direction ('asc' or 'desc'), defaults to 'asc'
   * @returns New IQueryable instance with ordering applied
   *
   * @remarks
   * Immutable operation - returns new instance.
   * Multiple orderBy() calls create multi-field sorting.
   *
   * @example
   * ```typescript
   * query
   *   .orderBy('status', 'asc')
   *   .orderBy('createdAt', 'desc')
   * // Sorts by status ascending, then createdAt descending
   * ```
   */
  orderBy(field: string, direction?: 'asc' | 'desc'): IQueryable<T>

  /**
   * Skip a number of records (pagination offset).
   *
   * @param count - Number of records to skip
   * @returns New IQueryable instance with skip applied
   *
   * @remarks
   * Immutable operation - returns new instance.
   * Used with take() for pagination.
   */
  skip(count: number): IQueryable<T>

  /**
   * Take a maximum number of records (page size).
   *
   * @param count - Maximum number of records to return
   * @returns New IQueryable instance with take applied
   *
   * @remarks
   * Immutable operation - returns new instance.
   * Used with skip() for pagination.
   */
  take(count: number): IQueryable<T>

  /**
   * Execute query and return all matching items.
   *
   * @returns Promise resolving to array of matching items
   *
   * @remarks
   * Terminal operation - executes the query via backend.
   * Respects all applied filters, ordering, skip, and take.
   *
   * @example
   * ```typescript
   * const users = await collection.query()
   *   .where({ status: 'active' })
   *   .orderBy('name', 'asc')
   *   .toArray()
   * ```
   */
  toArray(): Promise<T[]>

  /**
   * Execute query and return first matching item.
   *
   * @returns Promise resolving to first item or undefined if no matches
   *
   * @remarks
   * Terminal operation - executes query with take(1) optimization.
   * Returns undefined if no items match the query.
   *
   * @example
   * ```typescript
   * const user = await collection.query()
   *   .where({ email: 'alice@example.com' })
   *   .first()
   * if (user) {
   *   console.log(user.name)
   * }
   * ```
   */
  first(): Promise<T | undefined>

  /**
   * Execute query and return count of matching items.
   *
   * @returns Promise resolving to count of matching items
   *
   * @remarks
   * Terminal operation - executes query and returns count.
   * More efficient than toArray().length for some backends.
   *
   * @example
   * ```typescript
   * const activeCount = await collection.query()
   *   .where({ status: 'active' })
   *   .count()
   * ```
   */
  count(): Promise<number>

  /**
   * Execute query and check if any items match.
   *
   * @returns Promise resolving to true if any items match, false otherwise
   *
   * @remarks
   * Terminal operation - executes query with take(1) optimization.
   * More efficient than toArray().length > 0 for some backends.
   *
   * @example
   * ```typescript
   * const hasActive = await collection.query()
   *   .where({ status: 'active' })
   *   .any()
   * if (hasActive) {
   *   console.log('Active items exist')
   * }
   * ```
   */
  any(): Promise<boolean>
}

// ============================================================================
// QueryBuilder Implementation
// ============================================================================

/**
 * Internal query builder state.
 */
interface QueryBuilderState {
  /** Combined filter conditions (multiple where calls are merged) */
  filters: QueryFilter[]
  /** Ordering clauses (multiple orderBy calls are accumulated) */
  ordering: OrderByClause[]
  /** Number of records to skip */
  skipCount?: number
  /** Maximum number of records to return */
  takeCount?: number
}

/**
 * Immutable query builder implementation.
 *
 * @remarks
 * Implements IQueryable interface with immutable pattern.
 * Each chainable method creates a new instance with updated state.
 * Terminal operations delegate to IQueryExecutor.
 */
class QueryBuilder<T> implements IQueryable<T> {
  constructor(
    private executor: IQueryExecutor<T>,
    private state: QueryBuilderState,
    private onResults?: (results: T[]) => void
  ) {}

  where(filter: QueryFilter): IQueryable<T> {
    return new QueryBuilder<T>(this.executor, {
      ...this.state,
      filters: [...this.state.filters, filter]
    }, this.onResults)
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): IQueryable<T> {
    return new QueryBuilder<T>(this.executor, {
      ...this.state,
      ordering: [...this.state.ordering, { field, direction }]
    }, this.onResults)
  }

  skip(count: number): IQueryable<T> {
    return new QueryBuilder<T>(this.executor, {
      ...this.state,
      skipCount: count
    }, this.onResults)
  }

  take(count: number): IQueryable<T> {
    return new QueryBuilder<T>(this.executor, {
      ...this.state,
      takeCount: count
    }, this.onResults)
  }

  async toArray(): Promise<T[]> {
    const ast = this.buildAST()
    const options = {
      orderBy: this.state.ordering.length > 0 ? this.state.ordering : undefined,
      skip: this.state.skipCount,
      take: this.state.takeCount
    }

    const results = await this.executor.select(ast, options)
    this.onResults?.(results)
    return results
  }

  async first(): Promise<T | undefined> {
    const ast = this.buildAST()
    const options = {
      orderBy: this.state.ordering.length > 0 ? this.state.ordering : undefined,
      skip: this.state.skipCount,
      // Note: first() optimization happens in executor.first()
    }

    const result = await this.executor.first(ast, options)
    this.onResults?.(result ? [result] : [])
    return result
  }

  async count(): Promise<number> {
    const ast = this.buildAST()
    // Count doesn't need ordering or pagination
    return this.executor.count(ast)
  }

  async any(): Promise<boolean> {
    const ast = this.buildAST()
    // Exists doesn't need ordering or pagination
    return this.executor.exists(ast)
  }

  /**
   * Build combined AST from all filter conditions.
   *
   * @returns Condition AST (or empty condition if no filters)
   *
   * @remarks
   * Multiple where() calls are combined with $and logic.
   * If no filters, returns empty object (matches all).
   */
  private buildAST() {
    if (this.state.filters.length === 0) {
      // Empty filter matches all items
      return parseQuery({})
    }

    if (this.state.filters.length === 1) {
      return parseQuery(this.state.filters[0])
    }

    // Multiple filters: combine with $and
    return parseQuery({ $and: this.state.filters })
  }
}

// ============================================================================
// CollectionQueryable Mixin
// ============================================================================

/**
 * Queryable mixin for collections.
 * Provides .query() method returning IQueryable builder.
 *
 * @remarks
 * Requirements:
 * - Collection must have `modelName` view (from createCollectionModels)
 * - Collection must have `all()` method returning T[] array
 * - Environment must provide backendRegistry service
 *
 * Usage:
 * ```typescript
 * const MyCollection = types.compose(
 *   BaseCollection,
 *   CollectionQueryable
 * ).named('MyCollection')
 *
 * const collection = MyCollection.create({}, environment)
 * const results = await collection.query()
 *   .where({ status: 'active' })
 *   .orderBy('name', 'asc')
 *   .toArray()
 * ```
 */
export const CollectionQueryable = types
  .model('CollectionQueryable', {})
  .actions((self) => ({
    /**
     * Sync results from remote query into MST collection.
     * Uses items.put() for upsert semantics (add or update by id).
     *
     * @param results - Array of entities from remote query
     */
    syncFromRemote(results: any[]) {
      for (const item of results) {
        ;(self as any).items.put(item)
      }
    }
  }))
  .views((self) => ({
    /**
     * Create a new query builder for this collection.
     *
     * @returns IQueryable builder instance
     *
     * @remarks
     * Returns an immutable query builder. Each chainable method
     * returns a new instance. Terminal operations execute the query.
     *
     * Resolves IQueryExecutor from environment's BackendRegistry with
     * collection reference bound for memory backends or table name bound
     * for SQL backends.
     *
     * For remote executors (e.g., PostgreSQL), a sync callback is registered
     * to populate the MST collection with query results.
     *
     * @example
     * ```typescript
     * const query = collection.query()
     *   .where({ status: 'active' })
     *   .orderBy('createdAt', 'desc')
     *   .skip(20)
     *   .take(10)
     *
     * const results = await query.toArray()
     * ```
     */
    query<T>(): IQueryable<T> {
      const env = getEnv<IEnvironment>(self)
      const schemaName = env.context!.schemaName
      const modelName = (self as any).modelName

      // Get pre-computed maps from env.context (if available)
      // This enables createStore() to work with SQL backends without meta-store registration
      const columnPropertyMap = (env.context as any)?.columnPropertyMaps?.[modelName]
      const propertyTypes = (env.context as any)?.propertyTypeMaps?.[modelName]

      // Resolve executor from registry with collection reference and pre-computed maps
      const executor = env.services.backendRegistry.resolve<T>(
        schemaName,
        modelName,
        self,  // Pass collection reference for memory backends
        columnPropertyMap,  // Pass pre-computed column map (bypasses meta-store lookup)
        propertyTypes  // Pass pre-computed property types for dialect-specific conversions
      )

      // Register sync callback for remote executors
      const onResults = executor.executorType === 'remote'
        ? (results: T[]) => (self as any).syncFromRemote(results)
        : undefined

      const initialState: QueryBuilderState = {
        filters: [],
        ordering: [],
        skipCount: undefined,
        takeCount: undefined
      }

      return new QueryBuilder<T>(executor, initialState, onResults)
    }
  }))
