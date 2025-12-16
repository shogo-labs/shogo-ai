/**
 * Query Executor Types
 *
 * IQueryExecutor is the internal execution interface that mirrors IQueryable's
 * terminal operations. It's what QueryBuilder delegates to.
 *
 * This interface is backend-agnostic - both MemoryQueryExecutor and
 * SqlQueryExecutor implement it.
 */

import type { Condition } from "../ast/types"
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
   * Execute a select query and return matching items.
   *
   * @param ast - Query condition AST (from parseQuery)
   * @param options - Optional query options (orderBy, skip, take)
   * @returns Promise resolving to array of matching items
   */
  select(ast: Condition, options?: QueryOptions): Promise<T[]>

  /**
   * Execute a query and return the first matching item.
   *
   * @param ast - Query condition AST (from parseQuery)
   * @param options - Optional query options (orderBy, skip)
   * @returns Promise resolving to first item or undefined
   */
  first(ast: Condition, options?: QueryOptions): Promise<T | undefined>

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
  count(ast: Condition): Promise<number>

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
  exists(ast: Condition): Promise<boolean>
}
