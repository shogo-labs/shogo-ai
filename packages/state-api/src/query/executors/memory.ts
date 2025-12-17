/**
 * MemoryQueryExecutor
 *
 * Query executor for in-memory collections.
 * Filters MST collection data using @ucast/js interpretation.
 *
 * Data source is bound at construction - collection reference is stored
 * and accessed via collection.all() when executing queries.
 */

import { createJsInterpreter, allInterpreters } from "@ucast/js"
import { FieldCondition } from "@ucast/core"
import type { Condition } from "../ast/types"
import type { QueryOptions, OrderByClause } from "../backends/types"
import type { IQueryExecutor } from "./types"

// ============================================================================
// Custom Interpreters (from MemoryBackend)
// ============================================================================

/**
 * Custom interpreter for $contains operator.
 */
function contains(
  condition: FieldCondition<any>,
  object: any,
  { get }: { get: (obj: any, field: string) => any }
) {
  const value = get(object, condition.field)

  if (typeof value === "string" && typeof condition.value === "string") {
    return value.includes(condition.value)
  }

  if (Array.isArray(value)) {
    return value.includes(condition.value)
  }

  return false
}

const extendedInterpreters = {
  ...allInterpreters,
  contains,
}

const interpret = createJsInterpreter(extendedInterpreters)

// ============================================================================
// MemoryQueryExecutor Implementation
// ============================================================================

export class MemoryQueryExecutor<T> implements IQueryExecutor<T> {
  constructor(private collection: any) {
    // Collection reference bound at creation
    // Expected interface: { all(): T[], modelName: string }
  }

  async select(ast: Condition, options?: QueryOptions): Promise<T[]> {
    // Get all items from bound collection
    let results = this.collection.all() as T[]

    // Step 1: Filter using @ucast/js
    if (ast) {
      results = results.filter((item) => interpret(ast, item))
    }

    // Step 2: Sort
    if (options?.orderBy) {
      results = this.applyOrderBy(results, options.orderBy)
    }

    // Step 3: Paginate
    if (options?.skip !== undefined) {
      results = results.slice(options.skip)
    }
    if (options?.take !== undefined) {
      results = results.slice(0, options.take)
    }

    return results
  }

  async first(ast: Condition, options?: QueryOptions): Promise<T | undefined> {
    // Optimization: Use select() with take:1
    const results = await this.select(ast, { ...options, take: 1 })
    return results[0]
  }

  async count(ast: Condition): Promise<number> {
    // Filter and count - no need for sorting/pagination
    let results = this.collection.all() as T[]

    if (ast) {
      results = results.filter((item) => interpret(ast, item))
    }

    return results.length
  }

  async exists(ast: Condition): Promise<boolean> {
    // Early-exit optimization - stop on first match
    const items = this.collection.all() as T[]

    if (!ast) {
      // No filter - check if any items exist
      return items.length > 0
    }

    // Check each item, exit early on first match
    for (const item of items) {
      if (interpret(ast, item)) {
        return true
      }
    }

    return false
  }

  /**
   * Apply multi-field sorting to results.
   * Adapted from MemoryBackend.applyOrderBy()
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
          return direction === "desc" ? -comparison : comparison
        }
      }
      return 0
    })
  }

  /**
   * Get nested value from object using dot notation.
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split(".").reduce((current, part) => current?.[part], obj)
  }
}

