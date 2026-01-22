/**
 * Query Executor Types
 *
 * IQueryExecutor is the internal execution interface that mirrors IQueryable's
 * terminal operations. It's what QueryBuilder delegates to.
 *
 * This interface is backend-agnostic - both MemoryQueryExecutor and
 * SqlQueryExecutor implement it.
 */

import type { ParsedCondition } from "../ast/types"
import type { QueryOptions } from "../backends/types"

/**
 * Query executor interface for backend-agnostic query execution.
 *
 * This interface mirrors the terminal operations of IQueryable but at the
 * execution layer. Implementations handle the actual data access and
 * filtering logic.
 *
 * @template T - The entity type being queried
 */
export interface IQueryExecutor<T> {
  /**
   * Discriminator for executor type.
   * - 'local': Mutations directly modify the bound collection (e.g., MemoryQueryExecutor)
   * - 'remote': Mutations execute against external store, MST sync needed (e.g., SqlQueryExecutor)
   */
  readonly executorType: 'local' | 'remote'
  /**
   * Execute a select query and return matching items.
   *
   * @param ast - Query condition AST (from parseQuery)
   * @param options - Optional query options (orderBy, skip, take)
   * @returns Promise resolving to array of matching items
   */
  select(ast: ParsedCondition, options?: QueryOptions): Promise<T[]>

  /**
   * Execute a query and return the first matching item.
   *
   * @param ast - Query condition AST (from parseQuery)
   * @param options - Optional query options (orderBy, skip)
   * @returns Promise resolving to first item or undefined
   */
  first(ast: ParsedCondition, options?: QueryOptions): Promise<T | undefined>

  /**
   * Execute a count query and return the number of matching items.
   *
   * @param ast - Query condition AST (from parseQuery)
   * @returns Promise resolving to count of matching items
   *
   * @remarks
   * For SQL backends, this should use COUNT(*) optimization.
   * For memory backends, this filters and returns length.
   */
  count(ast: ParsedCondition): Promise<number>

  /**
   * Execute an existence check query.
   *
   * @param ast - Query condition AST (from parseQuery)
   * @returns Promise resolving to true if any items match, false otherwise
   *
   * @remarks
   * For SQL backends, this should use EXISTS or LIMIT 1 optimization.
   * For memory backends, this can early-exit on first match.
   */
  exists(ast: ParsedCondition): Promise<boolean>

  // ==========================================================================
  // Mutation Operations
  // ==========================================================================

  /**
   * Insert a new entity.
   *
   * @param entity - Partial entity data (id may be generated)
   * @returns Promise resolving to the inserted entity with all fields
   *
   * @remarks
   * For SQL backends, generates INSERT statement and uses RETURNING.
   * For memory backends, adds to collection with auto-generated ID if needed.
   */
  insert(entity: Partial<T>): Promise<T>

  /**
   * Update an existing entity by ID.
   *
   * @param id - Entity identifier
   * @param changes - Partial entity with fields to update
   * @returns Promise resolving to updated entity, or undefined if not found
   *
   * @remarks
   * Supports partial updates - only specified fields are modified.
   * Returns undefined if no entity with the given ID exists.
   */
  update(id: string, changes: Partial<T>): Promise<T | undefined>

  /**
   * Delete an entity by ID.
   *
   * @param id - Entity identifier
   * @returns Promise resolving to true if deleted, false if not found
   */
  delete(id: string): Promise<boolean>

  /**
   * Insert multiple entities in a batch.
   *
   * @param entities - Array of partial entity data
   * @returns Promise resolving to array of inserted entities
   *
   * @remarks
   * For SQL backends, uses transaction for atomicity.
   * For memory backends, adds each to collection.
   */
  insertMany(entities: Partial<T>[]): Promise<T[]>

  /**
   * Update multiple entities matching a filter.
   *
   * @param ast - Query condition AST (from parseQuery)
   * @param changes - Partial entity with fields to update
   * @returns Promise resolving to count of updated entities
   */
  updateMany(ast: ParsedCondition, changes: Partial<T>): Promise<number>

  /**
   * Delete multiple entities matching a filter.
   *
   * @param ast - Query condition AST (from parseQuery)
   * @returns Promise resolving to count of deleted entities
   */
  deleteMany(ast: ParsedCondition): Promise<number>
}
