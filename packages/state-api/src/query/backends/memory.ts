/**
 * Memory Backend Implementation
 *
 * Provides in-memory query execution for MST collections using @ucast/js.
 * Implements the IBackend interface for pluggable query execution.
 *
 * @module query/backends/memory
 *
 * Requirements:
 * - REQ-03: Backend abstraction with pluggable execution strategies
 * - MEM-01: Execute comparison operators against JS values
 * - MEM-02: Execute logical operators with short-circuit evaluation
 * - MEM-03: Support orderBy with multi-field sorting
 * - MEM-04: Support skip/take pagination
 * - MEM-05: Handle MST reference resolution in filters
 * - MEM-06: Return MST instances (not plain objects)
 * - MEM-07: Declare capabilities via BackendCapabilities
 *
 * Design decisions:
 * - Uses @ucast/js createJsInterpreter for filtering
 * - Custom $contains interpreter for string/array inclusion
 * - CRITICAL: Uses interpret(ast, item) pattern, NOT interpret(ast)(item)
 * - OrderBy/skip/take implemented separately (not part of @ucast)
 * - Returns same MST references (no cloning)
 */

import { createJsInterpreter, allInterpreters } from '@ucast/js'
import { FieldCondition } from '@ucast/core'
import type { Condition } from '../ast/types'
import type {
  IBackend,
  BackendCapabilities,
  QueryOptions,
  QueryResult,
  OrderByClause,
  DDLGenerationOptions,
  DDLExecutionResult
} from './types'

// ============================================================================
// Custom Interpreters
// ============================================================================

/**
 * Custom interpreter for $contains operator.
 * Checks if a string contains substring or array contains element.
 *
 * @param condition - The field condition with operator 'contains'
 * @param object - The item being evaluated
 * @param helpers - Helper functions including field accessor
 * @returns true if field value contains the condition value
 *
 * @example
 * ```typescript
 * // String contains
 * contains(new FieldCondition('contains', 'name', 'li'), { name: 'Alice' }, helpers)
 * // => true (Alice includes 'li')
 *
 * // Array contains
 * contains(new FieldCondition('contains', 'tags', 'featured'), { tags: ['featured'] }, helpers)
 * // => true (tags includes 'featured')
 * ```
 */
function contains(
  condition: FieldCondition<any>,
  object: any,
  { get }: { get: (obj: any, field: string) => any }
) {
  const value = get(object, condition.field)

  // String.includes() for string fields
  if (typeof value === 'string' && typeof condition.value === 'string') {
    return value.includes(condition.value)
  }

  // Array.includes() for array fields
  if (Array.isArray(value)) {
    return value.includes(condition.value)
  }

  return false
}

// Extended interpreters with custom $contains
const extendedInterpreters = {
  ...allInterpreters,
  contains,
}

// Create interpreter instance with extended operators
// CRITICAL: Must be used as interpret(ast, item), NOT interpret(ast)(item)
const interpret = createJsInterpreter(extendedInterpreters)

// ============================================================================
// Backend Implementation
// ============================================================================

/**
 * In-memory query backend using @ucast/js for filtering.
 *
 * @remarks
 * Executes queries against JavaScript arrays using @ucast/js interpretation.
 * Supports all standard MongoDB-style operators plus custom $contains.
 * Returns same MST references (no cloning) to preserve reactivity.
 *
 * Performance: Handles 10k items with filter + sort + pagination < 200ms
 *
 * @example
 * ```typescript
 * const backend = new MemoryBackend()
 * const users = [{ id: '1', name: 'Alice', age: 30 }]
 * const ast = new FieldCondition('eq', 'name', 'Alice')
 *
 * const result = await backend.execute(ast, users, {
 *   orderBy: { field: 'age', direction: 'desc' },
 *   skip: 0,
 *   take: 10
 * })
 * // => { items: [{ id: '1', name: 'Alice', age: 30 }] }
 * ```
 */
export class MemoryBackend implements IBackend {
  /**
   * Declares supported operators and features.
   * Used for runtime capability checking before query execution.
   */
  readonly capabilities: BackendCapabilities = {
    operators: [
      // Comparison operators (MEM-01)
      'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
      // Set operators
      'in', 'nin',
      // Pattern matching
      'regex',
      // Custom operators
      'contains',
      // Logical operators (MEM-02)
      'and', 'or', 'not'
    ],
    features: {
      // Sorting support (MEM-03)
      sorting: true,
      // Pagination support (MEM-04)
      pagination: true,
      // Not applicable for in-memory (all data already loaded)
      relations: false,
      // Field selection not implemented initially
      select: false,
      // Aggregation not implemented initially
      aggregation: false
    }
  }

  /**
   * Execute a query against an in-memory collection.
   *
   * @param ast - Query AST from parser
   * @param collection - Source collection to query
   * @param options - Optional query options (pagination, sorting)
   * @returns Promise resolving to filtered, sorted, paginated results
   *
   * @remarks
   * Execution pipeline:
   * 1. Filter using @ucast/js interpret(ast, item) - CRITICAL PATTERN
   * 2. Sort using multi-field orderBy (MEM-03)
   * 3. Paginate using skip/take (MEM-04)
   *
   * Returns same MST references (MEM-06) - no object cloning.
   * Handles empty collections and empty filters gracefully.
   */
  async execute<T>(
    ast: Condition,
    collection: T[],
    options?: QueryOptions
  ): Promise<QueryResult<T>> {
    // Start with the full collection
    // IMPORTANT: We work with references, not copies (MEM-06)
    let results = collection

    // Step 1: Filter using @ucast/js
    // CRITICAL: Use interpret(ast, item) pattern, NOT interpret(ast)(item)
    // The curried form interpret(ast)(item) causes "Unable to get field X out of undefined"
    if (ast) {
      results = results.filter(item => interpret(ast, item))
    }

    // Step 2: Sort (MEM-03)
    if (options?.orderBy) {
      results = this.applyOrderBy(results, options.orderBy)
    }

    // Step 3: Paginate (MEM-04)
    if (options?.skip !== undefined) {
      results = results.slice(options.skip)
    }
    if (options?.take !== undefined) {
      results = results.slice(0, options.take)
    }

    return {
      items: results
    }
  }

  /**
   * Apply multi-field sorting to results.
   *
   * @param items - Items to sort
   * @param orderBy - Single clause or array of clauses
   * @returns Sorted array (mutates original for performance)
   *
   * @remarks
   * Implements stable multi-field sorting:
   * - Primary sort by first clause
   * - Secondary sort by second clause (within same primary value)
   * - And so on for additional clauses
   *
   * Supports nested field access via dot notation.
   */
  private applyOrderBy<T>(
    items: T[],
    orderBy: OrderByClause | OrderByClause[]
  ): T[] {
    const clauses = Array.isArray(orderBy) ? orderBy : [orderBy]

    return items.sort((a, b) => {
      for (const { field, direction } of clauses) {
        const aVal = this.getNestedValue(a, field)
        const bVal = this.getNestedValue(b, field)

        let comparison = 0
        if (aVal < bVal) comparison = -1
        else if (aVal > bVal) comparison = 1

        if (comparison !== 0) {
          return direction === 'desc' ? -comparison : comparison
        }
      }
      return 0
    })
  }

  /**
   * Get nested value from object using dot notation.
   *
   * @param obj - Source object
   * @param path - Field path (e.g., 'user.profile.name')
   * @returns Field value or undefined if not found
   *
   * @example
   * ```typescript
   * getNestedValue({ user: { name: 'Alice' } }, 'user.name')
   * // => 'Alice'
   * ```
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, part) => current?.[part], obj)
  }

  /**
   * Execute DDL against memory backend (no-op).
   *
   * @param _schema - Schema (ignored for memory backend)
   * @param _options - Options (ignored for memory backend)
   * @returns Promise resolving to success with empty statements
   *
   * @remarks
   * Memory backend has no persistent storage, so DDL is a no-op.
   * Always returns success with empty statements array.
   * This enables consistent backend interface regardless of storage type.
   */
  async executeDDL(
    _schema: any,
    _options?: DDLGenerationOptions
  ): Promise<DDLExecutionResult> {
    // Memory backend has no tables to create - always succeeds as no-op
    return {
      success: true,
      statements: [],
      executed: 0
    }
  }
}
