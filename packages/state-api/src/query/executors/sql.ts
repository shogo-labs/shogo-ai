/**
 * SqlQueryExecutor
 *
 * Query executor for SQL backends.
 * Composes SqlBackend (compilation) + ISqlExecutor (execution) + normalization.
 *
 * Handles bidirectional field name normalization:
 * - Input: camelCase → snake_case (for SQL generation)
 * - Output: snake_case → camelCase (for results)
 */

import type { Condition } from "../ast/types"
import type { QueryOptions, OrderByClause } from "../backends/types"
import type { IQueryExecutor } from "./types"
import type { SqlBackend } from "../backends/sql"
import type { ISqlExecutor } from "../execution/types"
import type { ColumnPropertyMap, PropertyTypeMap, SqlDialect } from "../execution/utils"
import { normalizeRowsWithTypes } from "../execution/utils"
import { toSnakeCase } from "../../ddl/utils"

export class SqlQueryExecutor<T> implements IQueryExecutor<T> {
  private propertyColumnMap: Map<string, string> // camelCase → snake_case (derived)

  constructor(
    private tableName: string,
    private sqlBackend: SqlBackend,
    private executor: ISqlExecutor,
    private columnPropertyMap: ColumnPropertyMap, // snake_case → camelCase (provided)
    private dialect: SqlDialect,
    private propertyTypes: PropertyTypeMap
  ) {
    // Derive inverse map for input normalization
    this.propertyColumnMap = this.invertMap(columnPropertyMap)
  }

  async select(ast: Condition, options?: QueryOptions): Promise<T[]> {
    // Normalize input: convert camelCase field names to snake_case
    const normalizedAst = this.normalizeAstFieldNames(ast)
    const normalizedOptions = this.normalizeInputOptions(options)

    // Compile to SQL
    const [whereSql, params] = this.sqlBackend.compileSelect(
      normalizedAst,
      this.tableName,
      normalizedOptions
    )

    // Build complete SELECT statement
    const fullSql = this.buildSelectSql(whereSql)

    // Execute SQL
    const rows = await this.executor.execute([fullSql, params])

    // Normalize output: convert snake_case columns to camelCase properties with type conversion
    return normalizeRowsWithTypes(
      rows,
      this.columnPropertyMap,
      this.dialect,
      this.propertyTypes
    ) as T[]
  }

  async first(ast: Condition, options?: QueryOptions): Promise<T | undefined> {
    // Optimization: Force take:1
    const results = await this.select(ast, { ...options, take: 1 })
    return results[0]
  }

  async count(ast: Condition): Promise<number> {
    // Normalize input AST field names
    const normalizedAst = this.normalizeAstFieldNames(ast)

    // Compile COUNT(*) query
    const [sql, params] = this.sqlBackend.compileCount(normalizedAst, this.tableName)

    // Execute and extract count value
    const rows = await this.executor.execute([sql, params])

    // COUNT(*) returns { 'COUNT(*)': N } or similar
    const countValue = rows[0] ? Object.values(rows[0])[0] : 0
    return countValue as number
  }

  async exists(ast: Condition): Promise<boolean> {
    // Normalize input AST field names
    const normalizedAst = this.normalizeAstFieldNames(ast)

    // Compile EXISTS query (LIMIT 1 optimization)
    const [sql, params] = this.sqlBackend.compileExists(normalizedAst, this.tableName)

    // Execute and check if any rows returned
    const rows = await this.executor.execute([sql, params])
    return rows.length > 0
  }

  /**
   * Normalize AST field names and values for SQL dialect.
   * Recursively transforms all FieldCondition nodes in the AST.
   */
  private normalizeAstFieldNames(ast: Condition): Condition {
    // Check if this is a FieldCondition (has 'field' property)
    if ('field' in ast && typeof ast.field === 'string') {
      const originalField = ast.field
      const normalizedField = this.normalizeInputField(originalField)
      const normalizedValue = this.normalizeAstValue(originalField, (ast as any).value)

      // Create new condition with normalized field name and value
      return {
        ...ast,
        field: normalizedField,
        value: normalizedValue
      } as Condition
    }

    // Check if this is a compound condition (has 'value' array of conditions)
    if ('value' in ast && Array.isArray(ast.value)) {
      return {
        ...ast,
        value: ast.value.map((child: Condition) => this.normalizeAstFieldNames(child))
      } as Condition
    }

    // Return as-is if not a field or compound condition
    return ast
  }

  /**
   * Normalize query value based on property type and dialect.
   * Handles dialect-specific type conversions (e.g., boolean → INTEGER for SQLite).
   */
  private normalizeAstValue(propertyName: string, value: any): any {
    const propType = this.propertyTypes[propertyName]

    // SQLite boolean conversion
    if (propType === 'boolean' && this.dialect === 'sqlite') {
      if (value === true) return 1
      if (value === false) return 0
      // null/undefined pass through
    }

    return value
  }

  /**
   * Build complete SELECT statement from WHERE clause.
   * Handles empty WHERE clause edge case.
   */
  private buildSelectSql(whereSql: string): string {
    const escapedTable = this.escapeTableName(this.tableName)

    // Handle empty WHERE clause (e.g., from parseQuery({}))
    // Empty AND generates "()" which is invalid SQL
    if (whereSql.trim().startsWith("()")) {
      const remainder = whereSql.substring(whereSql.indexOf("()") + 2).trim()
      return remainder
        ? `SELECT * FROM ${escapedTable} ${remainder}`
        : `SELECT * FROM ${escapedTable}`
    }

    if (whereSql && whereSql.trim() !== "") {
      return `SELECT * FROM ${escapedTable} WHERE ${whereSql}`
    }

    return `SELECT * FROM ${escapedTable}`
  }

  /**
   * Escape table name according to dialect.
   */
  private escapeTableName(name: string): string {
    if (this.dialect === 'sqlite') {
      return `\`${name.replace(/`/g, '``')}\``
    } else {
      return `"${name.replace(/"/g, '""')}"`
    }
  }

  /**
   * Normalize input options by converting camelCase field names to snake_case.
   */
  private normalizeInputOptions(options?: QueryOptions): QueryOptions | undefined {
    if (!options) return undefined

    const normalized = { ...options }

    // Normalize orderBy field names
    if (options.orderBy) {
      if (Array.isArray(options.orderBy)) {
        normalized.orderBy = options.orderBy.map((clause) =>
          this.normalizeInputOrderBy(clause)
        )
      } else {
        normalized.orderBy = this.normalizeInputOrderBy(options.orderBy)
      }
    }

    return normalized
  }

  /**
   * Normalize a single orderBy clause field name.
   */
  private normalizeInputOrderBy(clause: OrderByClause): OrderByClause {
    return {
      field: this.normalizeInputField(clause.field),
      direction: clause.direction
    }
  }

  /**
   * Normalize a camelCase field name to snake_case for SQL.
   * Uses property→column map if available, otherwise toSnakeCase.
   */
  private normalizeInputField(field: string): string {
    return this.propertyColumnMap.get(field) ?? toSnakeCase(field)
  }

  /**
   * Invert columnPropertyMap to create propertyColumnMap.
   * ColumnPropertyMap is Record<string, string> not Map.
   */
  private invertMap(columnPropertyMap: ColumnPropertyMap): Map<string, string> {
    const inverted = new Map<string, string>()
    for (const [column, property] of Object.entries(columnPropertyMap)) {
      inverted.set(property, column)
    }
    return inverted
  }
}

