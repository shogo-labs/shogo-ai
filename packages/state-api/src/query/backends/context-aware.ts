/**
 * Context-Aware Backend Wrapper
 *
 * Wraps an IBackend to provide schema-aware row normalization.
 * Uses a column-to-property mapping to correctly convert database column names
 * back to their original schema property names.
 *
 * @module query/backends/context-aware
 *
 * ## Why This Exists
 *
 * Generic snake_case → camelCase conversion is LOSSY for edge cases:
 * - `user_id` could be `userId` OR `userID`
 * - `https_url` could be `httpsUrl` OR `HTTPSUrl`
 *
 * The schema defines the correct property names. This wrapper uses a
 * column-to-property mapping (built from schema property names) to ensure
 * database rows are normalized to the ORIGINAL property names.
 *
 * ## Usage
 *
 * This wrapper is typically created by BackendRegistry.resolve() which:
 * 1. Looks up the model's property names from the meta-store
 * 2. Creates a columnPropertyMap using createColumnPropertyMap()
 * 3. Returns a ContextAwareBackend wrapping the resolved backend
 *
 * @example
 * ```typescript
 * const propertyNames = ['userId', 'HTTPSUrl', 'ID']
 * const columnPropertyMap = createColumnPropertyMap(propertyNames)
 * const contextAware = new ContextAwareBackend(postgresBackend, columnPropertyMap)
 *
 * const result = await contextAware.execute(ast, 'users')
 * // result.items have correct property names: { userId, HTTPSUrl, ID }
 * ```
 */

import type { Condition } from "../ast/types"
import type { IBackend, BackendCapabilities, QueryOptions, QueryResult } from "./types"
import type { ColumnPropertyMap } from "../execution/utils"
import { normalizeRowsWithSchema } from "../execution/utils"

/**
 * Backend wrapper that applies schema-aware row normalization.
 *
 * @remarks
 * This wrapper intercepts the results from the underlying backend and
 * normalizes column names using the column-to-property mapping.
 *
 * The wrapper is transparent - it exposes the same capabilities as the
 * underlying backend and delegates all execution to it.
 */
export class ContextAwareBackend implements IBackend {
  /**
   * Capabilities inherited from the wrapped backend.
   */
  readonly capabilities: BackendCapabilities

  /**
   * Create a context-aware backend wrapper.
   *
   * @param backend - The underlying backend to wrap
   * @param columnPropertyMap - Mapping from column names to property names
   */
  constructor(
    private readonly backend: IBackend,
    private readonly columnPropertyMap: ColumnPropertyMap
  ) {
    this.capabilities = backend.capabilities
  }

  /**
   * Execute a query and normalize results using schema mapping.
   *
   * @param ast - Query AST (from parseQuery)
   * @param collection - Collection/table name or array to query
   * @param options - Optional query options (pagination, sorting, etc.)
   * @returns Promise resolving to query results with normalized property names
   *
   * @remarks
   * Pipeline:
   * 1. Delegate execution to wrapped backend
   * 2. Normalize result rows using columnPropertyMap
   * 3. Preserve QueryResult metadata (totalCount, hasMore)
   */
  async execute<T>(
    ast: Condition,
    collection: T[] | string,
    options?: QueryOptions
  ): Promise<QueryResult<T>> {
    // Delegate to wrapped backend
    const result = await this.backend.execute<T>(ast, collection, options)

    // Normalize rows using schema-aware mapping
    const normalizedItems = normalizeRowsWithSchema(
      result.items as Record<string, unknown>[],
      this.columnPropertyMap
    )

    // Return normalized result, preserving metadata
    return {
      items: normalizedItems as T[],
      totalCount: result.totalCount,
      hasMore: result.hasMore,
    }
  }
}
