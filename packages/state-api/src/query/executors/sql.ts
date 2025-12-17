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
import {
  normalizeRowsWithTypes,
  normalizeRowWithTypes,
  entityToColumns,
  buildInsertSQL,
  buildUpdateSQL,
  buildDeleteSQL,
  createPropertyColumnMap,
} from "../execution/utils"
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

  // ==========================================================================
  // Mutation Operations
  // ==========================================================================

  /**
   * Insert a new entity into the database.
   */
  async insert(entity: Partial<T>): Promise<T> {
    // Generate ID if not provided
    const entityWithId = this.ensureId(entity)

    // Convert camelCase properties to snake_case columns
    const propertyColumnMapObj = this.getPropertyColumnMapObject()
    const columns = entityToColumns(entityWithId, propertyColumnMapObj)

    // Build INSERT SQL
    const columnNames = Object.keys(columns)
    const sql = buildInsertSQL(this.tableName, columnNames, this.dialect)
    const params = Object.values(columns)

    // Execute INSERT
    const rows = await this.executor.execute([sql, params])

    // For PostgreSQL with RETURNING, we get the row back
    if (rows.length > 0) {
      return normalizeRowWithTypes(
        rows[0],
        this.columnPropertyMap,
        this.dialect,
        this.propertyTypes
      ) as T
    }

    // For SQLite (no RETURNING), fetch the inserted row
    const idColumn = this.normalizeInputField("id")
    const selectSql = `SELECT * FROM "${this.tableName}" WHERE "${idColumn}" = ${this.dialect === "pg" ? "$1" : "?"}`
    const selectRows = await this.executor.execute([selectSql, [(entityWithId as any).id]])

    if (selectRows.length > 0) {
      return normalizeRowWithTypes(
        selectRows[0],
        this.columnPropertyMap,
        this.dialect,
        this.propertyTypes
      ) as T
    }

    // Return the entity with ID as fallback
    return entityWithId as T
  }

  /**
   * Update an existing entity by ID.
   */
  async update(id: string, changes: Partial<T>): Promise<T | undefined> {
    // Convert camelCase properties to snake_case columns
    const propertyColumnMapObj = this.getPropertyColumnMapObject()
    const columns = entityToColumns(changes, propertyColumnMapObj)

    // If no columns to update, just fetch and return current state
    const columnNames = Object.keys(columns)
    if (columnNames.length === 0) {
      return this.first({ type: "field", field: "id", operator: "eq", value: id })
    }

    // Build UPDATE SQL
    const idColumn = this.normalizeInputField("id")
    const sql = buildUpdateSQL(this.tableName, columnNames, idColumn, this.dialect)
    const params = [...Object.values(columns), id]

    // Execute UPDATE
    const rows = await this.executor.execute([sql, params])

    // For PostgreSQL with RETURNING
    if (rows.length > 0) {
      return normalizeRowWithTypes(
        rows[0],
        this.columnPropertyMap,
        this.dialect,
        this.propertyTypes
      ) as T
    }

    // For SQLite, fetch the updated row
    const selectSql = `SELECT * FROM "${this.tableName}" WHERE "${idColumn}" = ${this.dialect === "pg" ? "$1" : "?"}`
    const selectRows = await this.executor.execute([selectSql, [id]])

    if (selectRows.length > 0) {
      return normalizeRowWithTypes(
        selectRows[0],
        this.columnPropertyMap,
        this.dialect,
        this.propertyTypes
      ) as T
    }

    // Entity not found
    return undefined
  }

  /**
   * Delete an entity by ID.
   */
  async delete(id: string): Promise<boolean> {
    // Check if entity exists first
    const idColumn = this.normalizeInputField("id")
    const checkSql = `SELECT 1 FROM "${this.tableName}" WHERE "${idColumn}" = ${this.dialect === "pg" ? "$1" : "?"}`
    const exists = await this.executor.execute([checkSql, [id]])

    if (exists.length === 0) {
      return false
    }

    // Build and execute DELETE
    const sql = buildDeleteSQL(this.tableName, idColumn, this.dialect)
    await this.executor.execute([sql, [id]])

    return true
  }

  /**
   * Insert multiple entities using a transaction.
   */
  async insertMany(entities: Partial<T>[]): Promise<T[]> {
    if (entities.length === 0) {
      return []
    }

    const results: T[] = []

    // Use transaction for atomicity
    await this.executor.beginTransaction(async (tx) => {
      for (const entity of entities) {
        // Generate ID if not provided
        const entityWithId = this.ensureId(entity)

        // Convert to columns
        const propertyColumnMapObj = this.getPropertyColumnMapObject()
        const columns = entityToColumns(entityWithId, propertyColumnMapObj)

        // Build and execute INSERT
        const columnNames = Object.keys(columns)
        const sql = buildInsertSQL(this.tableName, columnNames, this.dialect)
        const params = Object.values(columns)

        const rows = await tx.execute([sql, params])

        // Get inserted row
        if (rows.length > 0) {
          results.push(
            normalizeRowWithTypes(
              rows[0],
              this.columnPropertyMap,
              this.dialect,
              this.propertyTypes
            ) as T
          )
        } else {
          // For SQLite, fetch the row
          const idColumn = this.normalizeInputField("id")
          const selectSql = `SELECT * FROM "${this.tableName}" WHERE "${idColumn}" = ${this.dialect === "pg" ? "$1" : "?"}`
          const selectRows = await tx.execute([selectSql, [(entityWithId as any).id]])

          if (selectRows.length > 0) {
            results.push(
              normalizeRowWithTypes(
                selectRows[0],
                this.columnPropertyMap,
                this.dialect,
                this.propertyTypes
              ) as T
            )
          } else {
            results.push(entityWithId as T)
          }
        }
      }
    })

    return results
  }

  /**
   * Update multiple entities matching a filter.
   */
  async updateMany(ast: Condition, changes: Partial<T>): Promise<number> {
    // Convert changes to columns
    const propertyColumnMapObj = this.getPropertyColumnMapObject()
    const columns = entityToColumns(changes, propertyColumnMapObj)

    const columnNames = Object.keys(columns)
    if (columnNames.length === 0) {
      return 0
    }

    // Normalize the filter AST
    const normalizedAst = this.normalizeAstFieldNames(ast)

    // Build SET clause
    const setClauses = columnNames
      .map((col, i) => {
        const placeholder = this.dialect === "pg" ? `$${i + 1}` : "?"
        return `"${col}" = ${placeholder}`
      })
      .join(", ")

    // Compile WHERE clause from AST
    const [whereClause, whereParams] = this.sqlBackend.compileWhere(normalizedAst)

    // Adjust placeholder indices for PostgreSQL
    let adjustedWhereClause = whereClause
    if (this.dialect === "pg" && whereParams.length > 0) {
      const offset = columnNames.length
      adjustedWhereClause = whereClause.replace(/\$(\d+)/g, (_, num) => `$${parseInt(num) + offset}`)
    }

    // Build UPDATE statement with dialect-specific affected row counting
    const whereStr = adjustedWhereClause ? ` WHERE ${adjustedWhereClause}` : ""
    const params = [...Object.values(columns), ...whereParams]

    if (this.dialect === "pg") {
      // PostgreSQL: Use RETURNING * and count returned rows
      const sql = `UPDATE "${this.tableName}" SET ${setClauses}${whereStr} RETURNING *`
      const rows = await this.executor.execute([sql, params])
      return rows.length
    } else {
      // SQLite: Execute UPDATE, then use changes() to get affected count
      const sql = `UPDATE "${this.tableName}" SET ${setClauses}${whereStr}`
      await this.executor.execute([sql, params])
      const changesResult = await this.executor.execute(["SELECT changes() as count", []])
      return (changesResult[0]?.count as number) ?? 0
    }
  }

  /**
   * Delete multiple entities matching a filter.
   */
  async deleteMany(ast: Condition): Promise<number> {
    // Normalize the filter AST
    const normalizedAst = this.normalizeAstFieldNames(ast)

    // Compile WHERE clause from AST
    const [whereClause, whereParams] = this.sqlBackend.compileWhere(normalizedAst)

    // Build DELETE statement with dialect-specific affected row counting
    const whereStr = whereClause ? ` WHERE ${whereClause}` : ""

    if (this.dialect === "pg") {
      // PostgreSQL: Use RETURNING * and count returned rows
      const sql = `DELETE FROM "${this.tableName}"${whereStr} RETURNING *`
      const rows = await this.executor.execute([sql, whereParams])
      return rows.length
    } else {
      // SQLite: Execute DELETE, then use changes() to get affected count
      const sql = `DELETE FROM "${this.tableName}"${whereStr}`
      await this.executor.execute([sql, whereParams])
      const changesResult = await this.executor.execute(["SELECT changes() as count", []])
      return (changesResult[0]?.count as number) ?? 0
    }
  }

  // ==========================================================================
  // Mutation Helpers
  // ==========================================================================

  /**
   * Ensure entity has an ID, generating one if not provided.
   */
  private ensureId(entity: Partial<T>): Partial<T> {
    if ((entity as any).id) {
      return entity
    }

    return {
      ...entity,
      id: this.generateId(),
    }
  }

  /**
   * Generate a unique ID.
   */
  private generateId(): string {
    // Simple UUID v4-like generation
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === "x" ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  /**
   * Get property→column mapping as a plain object for entityToColumns.
   */
  private getPropertyColumnMapObject(): Record<string, string> {
    const obj: Record<string, string> = {}
    for (const [prop, col] of this.propertyColumnMap) {
      obj[prop] = col
    }
    return obj
  }
}

