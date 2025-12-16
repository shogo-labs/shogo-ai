/**
 * SqlQueryExecutor
 *
 * Query executor for SQL backends.
 * Composes SqlBackend (compilation) + ISqlExecutor (execution) + normalization.
 *
 * Handles bidirectional field name normalization:
 * - Input: camelCase → snake_case (for SQL generation)
 * - Output: snake_case → camelCase (for results)
 *
 * This is a stub - implementation pending.
 */

import type { Condition } from "../ast/types"
import type { QueryOptions } from "../backends/types"
import type { IQueryExecutor } from "./types"
import type { SqlBackend } from "../backends/sql"
import type { ISqlExecutor } from "../execution/types"
import type { ColumnPropertyMap } from "../execution/utils"

export class SqlQueryExecutor<T> implements IQueryExecutor<T> {
  private propertyColumnMap: Map<string, string>  // camelCase → snake_case (derived)

  constructor(
    private tableName: string,
    private sqlBackend: SqlBackend,
    private executor: ISqlExecutor,
    private columnPropertyMap: ColumnPropertyMap  // snake_case → camelCase (provided)
  ) {
    // Derive inverse map for input normalization
    this.propertyColumnMap = this.invertMap(columnPropertyMap)
  }

  async select(ast: Condition, options?: QueryOptions): Promise<T[]> {
    throw new Error("SqlQueryExecutor.select() not implemented yet")
  }

  async first(ast: Condition, options?: QueryOptions): Promise<T | undefined> {
    throw new Error("SqlQueryExecutor.first() not implemented yet")
  }

  async count(ast: Condition): Promise<number> {
    throw new Error("SqlQueryExecutor.count() not implemented yet")
  }

  async exists(ast: Condition): Promise<boolean> {
    throw new Error("SqlQueryExecutor.exists() not implemented yet")
  }

  private invertMap(columnPropertyMap: ColumnPropertyMap): Map<string, string> {
    const inverted = new Map<string, string>()
    for (const [column, property] of columnPropertyMap.entries()) {
      inverted.set(property, column)
    }
    return inverted
  }
}
