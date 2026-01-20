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

import { Condition, FieldCondition, CompoundCondition } from "../ast/types"
import type { SubqueryCondition, ParsedCondition } from "../ast/types"
import type { QueryOptions, OrderByClause, ModelResolver, CompileContext } from "../backends/types"
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
import { toSnakeCase, type ArrayReferenceMetadata } from "../../ddl/utils"

/**
 * Metadata for a model in the schema.
 * Used by ModelResolver to resolve table/column names for subqueries.
 */
export interface SchemaModelMetadata {
  /** SQL table name (without quotes) */
  tableName: string
  /** Column → property mapping */
  columnPropertyMap: ColumnPropertyMap
  /** Identifier field name (usually 'id') */
  identifierField: string
}

export class SqlQueryExecutor<T> implements IQueryExecutor<T> {
  readonly executorType = 'remote' as const
  private propertyColumnMap: Map<string, string> // camelCase → snake_case (derived)
  private namespace?: string // Extracted from qualified table name
  private modelResolver?: ModelResolver // Lazy-created resolver for subqueries

  constructor(
    private tableName: string,
    private sqlBackend: SqlBackend,
    private executor: ISqlExecutor,
    private columnPropertyMap: ColumnPropertyMap, // snake_case → camelCase (provided)
    private dialect: SqlDialect,
    private propertyTypes: PropertyTypeMap,
    private arrayReferences?: Record<string, ArrayReferenceMetadata>,
    private schemaModels?: Map<string, SchemaModelMetadata> // For subquery support
  ) {
    // Derive inverse map for input normalization
    this.propertyColumnMap = this.invertMap(columnPropertyMap)
    // Extract namespace from qualified table name for junction table queries
    this.namespace = this.extractNamespace(tableName)
  }

  /**
   * Create a ModelResolver for subquery compilation.
   * Lazily created and cached.
   */
  private getModelResolver(): ModelResolver | undefined {
    if (this.modelResolver) {
      return this.modelResolver
    }

    if (!this.schemaModels || this.schemaModels.size === 0) {
      return undefined
    }

    this.modelResolver = this.createModelResolver()
    return this.modelResolver
  }

  /**
   * Create a ModelResolver from schema model metadata.
   */
  private createModelResolver(): ModelResolver {
    const schemaModels = this.schemaModels!
    const namespace = this.namespace
    const dialect = this.dialect

    return {
      getTableName: (modelName: string): string => {
        const meta = schemaModels.get(modelName)
        const baseName = meta?.tableName ?? `${modelName.toLowerCase()}s`

        // Apply namespace and quoting
        if (namespace) {
          if (dialect === 'pg') {
            return `"${namespace}"."${baseName}"`
          } else {
            return `"${namespace}__${baseName}"`
          }
        }

        return dialect === 'sqlite' ? `\`${baseName}\`` : `"${baseName}"`
      },

      getColumnName: (modelName: string, propertyName: string): string => {
        const meta = schemaModels.get(modelName)
        if (meta) {
          // Find the column name from the inverse of columnPropertyMap
          for (const [column, property] of Object.entries(meta.columnPropertyMap)) {
            if (property === propertyName) {
              return column
            }
          }
        }
        // Fallback to snake_case conversion
        return toSnakeCase(propertyName)
      },

      getIdentifierField: (modelName: string): string => {
        const meta = schemaModels.get(modelName)
        return meta?.identifierField ?? 'id'
      }
    }
  }

  /**
   * Get compile context for SQL compilation.
   * Includes ModelResolver if schema models are available.
   */
  private getCompileContext(): CompileContext {
    return {
      modelResolver: this.getModelResolver(),
      dialect: this.dialect
    }
  }

  /**
   * Extract namespace from a qualified table name.
   * PostgreSQL: "namespace"."table" → "namespace"
   * SQLite: namespace__table → namespace
   */
  private extractNamespace(tableName: string): string | undefined {
    if (this.dialect === 'pg') {
      // PostgreSQL: "namespace"."table" format
      const match = tableName.match(/^"([^"]+)"\./)
      return match ? match[1] : undefined
    } else {
      // SQLite: namespace__table format
      const parts = tableName.replace(/"/g, '').split('__')
      return parts.length > 1 ? parts[0] : undefined
    }
  }

  /**
   * Qualify a junction table name with the namespace.
   */
  private qualifyJunctionTable(junctionTable: string): string {
    if (!this.namespace) {
      return `"${junctionTable}"`
    }

    if (this.dialect === 'pg') {
      return `"${this.namespace}"."${junctionTable}"`
    } else {
      return `"${this.namespace}__${junctionTable}"`
    }
  }

  async select(ast: ParsedCondition, options?: QueryOptions): Promise<T[]> {
    // Normalize input: convert camelCase field names to snake_case
    const normalizedAst = this.normalizeAstFieldNames(ast)
    const normalizedOptions = this.normalizeInputOptions(options)

    // Compile to SQL with context for subquery support
    const [whereSql, params] = this.sqlBackend.compileSelect(
      normalizedAst,
      this.tableName,
      normalizedOptions,
      this.getCompileContext()
    )

    // Build complete SELECT statement
    const fullSql = this.buildSelectSql(whereSql)

    // Execute SQL
    const rows = await this.executor.execute([fullSql, params])

    // Normalize output: convert snake_case columns to camelCase properties with type conversion
    const entities = normalizeRowsWithTypes(
      rows,
      this.columnPropertyMap,
      this.dialect,
      this.propertyTypes
    ) as T[]

    // Hydrate array references from junction tables
    return this.hydrateArrayReferences(entities)
  }

  async first(ast: ParsedCondition, options?: QueryOptions): Promise<T | undefined> {
    // Optimization: Force take:1
    const results = await this.select(ast, { ...options, take: 1 })
    return results[0]
  }

  async count(ast: ParsedCondition): Promise<number> {
    // Normalize input AST field names
    const normalizedAst = this.normalizeAstFieldNames(ast)

    // Compile COUNT(*) query with context for subquery support
    const [sql, params] = this.sqlBackend.compileCount(
      normalizedAst,
      this.tableName,
      this.getCompileContext()
    )

    // Execute and extract count value
    const rows = await this.executor.execute([sql, params])

    // COUNT(*) returns { 'COUNT(*)': N } or similar
    // PostgreSQL returns bigint as string, so we need to parse it
    const countValue = rows[0] ? Object.values(rows[0])[0] : 0
    return typeof countValue === 'string' ? parseInt(countValue, 10) : (countValue as number)
  }

  async exists(ast: ParsedCondition): Promise<boolean> {
    // Normalize input AST field names
    const normalizedAst = this.normalizeAstFieldNames(ast)

    // Compile EXISTS query with context for subquery support
    const [sql, params] = this.sqlBackend.compileExists(
      normalizedAst,
      this.tableName,
      this.getCompileContext()
    )

    // Execute and check if any rows returned
    const rows = await this.executor.execute([sql, params])
    return rows.length > 0
  }

  // ==========================================================================
  // Array Reference Hydration
  // ==========================================================================

  /**
   * Get related IDs from a junction table for a specific entity and relation.
   *
   * @param entityId - The source entity ID
   * @param relationName - The property name of the array reference
   * @returns Array of target entity IDs
   * @throws Error if relation name is not in arrayReferences metadata
   */
  async getRelatedIds(entityId: string, relationName: string): Promise<string[]> {
    const meta = this.arrayReferences?.[relationName]
    if (!meta) {
      throw new Error(`Unknown array relation: ${relationName}`)
    }

    const placeholder = this.dialect === 'pg' ? '$1' : '?'
    const qualifiedTable = this.qualifyJunctionTable(meta.junctionTable)
    const sql = `SELECT "${meta.targetColumn}" FROM ${qualifiedTable} WHERE "${meta.sourceColumn}" = ${placeholder}`
    const rows = await this.executor.execute([sql, [entityId]])

    return rows.map(r => r[meta.targetColumn] as string)
  }

  /**
   * Hydrate array reference properties by querying junction tables.
   * Batches queries by collecting all entity IDs and querying once per relation.
   *
   * @param entities - Entities to hydrate
   * @returns Entities with array reference properties populated
   */
  private async hydrateArrayReferences(entities: T[]): Promise<T[]> {
    // Skip if no array references metadata or no entities
    if (!this.arrayReferences || Object.keys(this.arrayReferences).length === 0 || entities.length === 0) {
      return entities
    }

    // Collect all entity IDs
    const entityIds = entities.map(e => (e as any).id).filter(Boolean)
    if (entityIds.length === 0) {
      return entities
    }

    // Hydrate each array reference property
    for (const [propName, meta] of Object.entries(this.arrayReferences)) {
      // Batch query junction table for all entity IDs
      const placeholders = entityIds.map((_, i) =>
        this.dialect === 'pg' ? `$${i + 1}` : '?'
      ).join(', ')

      const qualifiedTable = this.qualifyJunctionTable(meta.junctionTable)
      const sql = `SELECT "${meta.sourceColumn}", "${meta.targetColumn}" FROM ${qualifiedTable} WHERE "${meta.sourceColumn}" IN (${placeholders})`
      const rows = await this.executor.execute([sql, entityIds])

      // Group target IDs by source ID
      const relMap = new Map<string, string[]>()
      for (const row of rows) {
        const sourceId = row[meta.sourceColumn] as string
        const targetId = row[meta.targetColumn] as string
        if (!relMap.has(sourceId)) {
          relMap.set(sourceId, [])
        }
        relMap.get(sourceId)!.push(targetId)
      }

      // Attach to entities
      for (const entity of entities) {
        (entity as any)[propName] = relMap.get((entity as any).id) ?? []
      }
    }

    return entities
  }

  /**
   * Normalize AST field names and values for SQL dialect.
   * Recursively transforms all FieldCondition and SubqueryCondition nodes in the AST.
   */
  private normalizeAstFieldNames(ast: Condition | SubqueryCondition): Condition | SubqueryCondition {
    // Check if this is a SubqueryCondition
    if (this.isSubqueryCondition(ast)) {
      // Normalize the outer field name only
      // Inner filter fields are normalized by the backend using ModelResolver
      return {
        type: 'subquery',
        field: this.normalizeInputField(ast.field),
        operator: ast.operator,
        subquery: ast.subquery  // Don't normalize inner filter here
      } as SubqueryCondition
    }

    // Check if this is a FieldCondition (has 'field' property)
    if ('field' in ast && typeof ast.field === 'string') {
      const originalField = ast.field
      const normalizedField = this.normalizeInputField(originalField)
      const normalizedValue = this.normalizeAstValue(originalField, (ast as any).value)

      // Create new condition with normalized field name and value
      return new FieldCondition((ast as any).operator, normalizedField, normalizedValue)
    }

    // Check if this is a compound condition (has 'value' array of conditions)
    // Note: Cast is safe because our backends handle both Condition and SubqueryCondition
    if ('value' in ast && Array.isArray(ast.value)) {
      const normalizedChildren = ast.value.map((child: Condition) =>
        this.normalizeAstFieldNames(child)
      ) as Condition[]
      return new CompoundCondition((ast as any).operator, normalizedChildren)
    }

    // Return as-is if not a field or compound condition
    return ast
  }

  /**
   * Check if an AST node is a SubqueryCondition.
   */
  private isSubqueryCondition(ast: any): ast is SubqueryCondition {
    return ast && typeof ast === 'object' && ast.type === 'subquery'
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
   * Handles pre-qualified names (from namespace isolation) without double-escaping.
   *
   * Pre-qualified formats:
   * - PostgreSQL: "namespace"."table" (already escaped)
   * - SQLite: namespace__table (needs escaping)
   */
  private escapeTableName(name: string): string {
    if (this.dialect === 'sqlite') {
      // SQLite: prefixed names use __ separator, escape the whole thing
      return `"${name.replace(/"/g, '""')}"`
    } else {
      // PostgreSQL: check if already a qualified name (starts with quote and contains "."")
      if (name.startsWith('"') && name.includes('"."')) {
        return name // Already escaped qualified name
      }
      // Standard escaping for simple names
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
   * Handles array references by writing to junction tables.
   */
  async insert(entity: Partial<T>): Promise<T> {
    // Generate ID if not provided
    const entityWithId = this.ensureId(entity)

    // Extract array reference values before building columns
    const arrayRefValues = this.extractArrayReferenceValues(entityWithId)

    // Convert camelCase properties to snake_case columns (excluding array refs)
    const propertyColumnMapObj = this.getPropertyColumnMapObject()
    const entityWithoutArrayRefs = this.removeArrayReferenceProperties(entityWithId)
    const columns = entityToColumns(entityWithoutArrayRefs, propertyColumnMapObj)

    // Build INSERT SQL
    const columnNames = Object.keys(columns)
    const sql = buildInsertSQL(this.tableName, columnNames, this.dialect)
    const params = Object.values(columns)

    // Execute INSERT
    await this.executor.execute([sql, params])

    // Insert junction table rows for array references
    await this.insertJunctionRows((entityWithId as any).id, arrayRefValues)

    // Fetch and hydrate the inserted entity
    const idColumn = this.normalizeInputField("id")
    const escapedTable = this.escapeTableName(this.tableName)
    const selectSql = `SELECT * FROM ${escapedTable} WHERE "${idColumn}" = ${this.dialect === "pg" ? "$1" : "?"}`
    const selectRows = await this.executor.execute([selectSql, [(entityWithId as any).id]])

    if (selectRows.length > 0) {
      const normalized = normalizeRowWithTypes(
        selectRows[0],
        this.columnPropertyMap,
        this.dialect,
        this.propertyTypes
      ) as T
      // Hydrate array references
      const hydrated = await this.hydrateArrayReferences([normalized])
      return hydrated[0]
    }

    // Fallback: return entity with array refs attached
    return { ...entityWithId, ...Object.fromEntries(
      Object.entries(arrayRefValues).map(([k, v]) => [k, v ?? []])
    ) } as T
  }

  /**
   * Update an existing entity by ID.
   * Handles array references by replacing junction table rows.
   */
  async update(id: string, changes: Partial<T>): Promise<T | undefined> {
    // Extract array reference values before building columns
    const arrayRefValues = this.extractArrayReferenceValues(changes)
    const hasArrayRefChanges = Object.keys(arrayRefValues).length > 0

    // Convert camelCase properties to snake_case columns (excluding array refs)
    const propertyColumnMapObj = this.getPropertyColumnMapObject()
    const changesWithoutArrayRefs = this.removeArrayReferenceProperties(changes)
    const columns = entityToColumns(changesWithoutArrayRefs, propertyColumnMapObj)

    // If no columns to update (only array refs or empty), handle specially
    const columnNames = Object.keys(columns)
    if (columnNames.length === 0 && !hasArrayRefChanges) {
      return this.first(new FieldCondition('eq', 'id', id))
    }

    // Update main table if there are column changes
    if (columnNames.length > 0) {
      const idColumn = this.normalizeInputField("id")
      const sql = buildUpdateSQL(this.tableName, columnNames, idColumn, this.dialect)
      const params = [...Object.values(columns), id]
      await this.executor.execute([sql, params])
    }

    // Update junction tables for array reference changes
    if (hasArrayRefChanges) {
      await this.replaceJunctionRows(id, arrayRefValues)
    }

    // Fetch and hydrate the updated entity
    const idColumn = this.normalizeInputField("id")
    const escapedTable = this.escapeTableName(this.tableName)
    const selectSql = `SELECT * FROM ${escapedTable} WHERE "${idColumn}" = ${this.dialect === "pg" ? "$1" : "?"}`
    const rows = await this.executor.execute([selectSql, [id]])

    if (rows.length > 0) {
      const normalized = normalizeRowWithTypes(
        rows[0],
        this.columnPropertyMap,
        this.dialect,
        this.propertyTypes
      ) as T
      // Hydrate array references
      const hydrated = await this.hydrateArrayReferences([normalized])
      return hydrated[0]
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
    const escapedTable = this.escapeTableName(this.tableName)
    const checkSql = `SELECT 1 FROM ${escapedTable} WHERE "${idColumn}" = ${this.dialect === "pg" ? "$1" : "?"}`
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
          const escapedTable = this.escapeTableName(this.tableName)
          const selectSql = `SELECT * FROM ${escapedTable} WHERE "${idColumn}" = ${this.dialect === "pg" ? "$1" : "?"}`
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
  async updateMany(ast: ParsedCondition, changes: Partial<T>): Promise<number> {
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
    const escapedTable = this.escapeTableName(this.tableName)

    if (this.dialect === "pg") {
      // PostgreSQL: Use RETURNING * and count returned rows
      const sql = `UPDATE ${escapedTable} SET ${setClauses}${whereStr} RETURNING *`
      const rows = await this.executor.execute([sql, params])
      return rows.length
    } else {
      // SQLite: Execute UPDATE, then use changes() to get affected count
      const sql = `UPDATE ${escapedTable} SET ${setClauses}${whereStr}`
      await this.executor.execute([sql, params])
      const changesResult = await this.executor.execute(["SELECT changes() as count", []])
      return (changesResult[0]?.count as number) ?? 0
    }
  }

  /**
   * Delete multiple entities matching a filter.
   */
  async deleteMany(ast: ParsedCondition): Promise<number> {
    // Normalize the filter AST
    const normalizedAst = this.normalizeAstFieldNames(ast)

    // Compile WHERE clause from AST
    const [whereClause, whereParams] = this.sqlBackend.compileWhere(normalizedAst)

    // Build DELETE statement with dialect-specific affected row counting
    const whereStr = whereClause ? ` WHERE ${whereClause}` : ""
    const escapedTable = this.escapeTableName(this.tableName)

    if (this.dialect === "pg") {
      // PostgreSQL: Use RETURNING * and count returned rows
      const sql = `DELETE FROM ${escapedTable}${whereStr} RETURNING *`
      const rows = await this.executor.execute([sql, whereParams])
      return rows.length
    } else {
      // SQLite: Execute DELETE, then use changes() to get affected count
      const sql = `DELETE FROM ${escapedTable}${whereStr}`
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
    return crypto.randomUUID()
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

  // ==========================================================================
  // Array Reference Mutation Helpers
  // ==========================================================================

  /**
   * Extract array reference values from an entity.
   * Returns a map of property name → array of target IDs.
   */
  private extractArrayReferenceValues(entity: Partial<T>): Record<string, string[] | undefined> {
    if (!this.arrayReferences) {
      return {}
    }

    const values: Record<string, string[] | undefined> = {}
    for (const propName of Object.keys(this.arrayReferences)) {
      if (propName in (entity as any)) {
        values[propName] = (entity as any)[propName]
      }
    }
    return values
  }

  /**
   * Remove array reference properties from an entity.
   * Returns a new entity without array reference properties.
   */
  private removeArrayReferenceProperties(entity: Partial<T>): Partial<T> {
    if (!this.arrayReferences) {
      return entity
    }

    const result = { ...entity } as any
    for (const propName of Object.keys(this.arrayReferences)) {
      delete result[propName]
    }
    return result as Partial<T>
  }

  /**
   * Insert junction table rows for array reference values.
   */
  private async insertJunctionRows(
    entityId: string,
    arrayRefValues: Record<string, string[] | undefined>
  ): Promise<void> {
    if (!this.arrayReferences) {
      return
    }

    for (const [propName, targetIds] of Object.entries(arrayRefValues)) {
      const meta = this.arrayReferences[propName]
      if (!meta || !targetIds || targetIds.length === 0) {
        continue
      }

      // Insert each junction row
      const qualifiedTable = this.qualifyJunctionTable(meta.junctionTable)
      for (const targetId of targetIds) {
        const placeholder1 = this.dialect === 'pg' ? '$1' : '?'
        const placeholder2 = this.dialect === 'pg' ? '$2' : '?'
        const sql = `INSERT INTO ${qualifiedTable} ("${meta.sourceColumn}", "${meta.targetColumn}") VALUES (${placeholder1}, ${placeholder2})`
        await this.executor.execute([sql, [entityId, targetId]])
      }
    }
  }

  /**
   * Replace junction table rows for array reference values.
   * Deletes existing rows and inserts new ones.
   */
  private async replaceJunctionRows(
    entityId: string,
    arrayRefValues: Record<string, string[] | undefined>
  ): Promise<void> {
    if (!this.arrayReferences) {
      return
    }

    for (const [propName, targetIds] of Object.entries(arrayRefValues)) {
      const meta = this.arrayReferences[propName]
      if (!meta) {
        continue
      }

      const qualifiedTable = this.qualifyJunctionTable(meta.junctionTable)

      // Delete existing junction rows
      const deletePlaceholder = this.dialect === 'pg' ? '$1' : '?'
      const deleteSql = `DELETE FROM ${qualifiedTable} WHERE "${meta.sourceColumn}" = ${deletePlaceholder}`
      await this.executor.execute([deleteSql, [entityId]])

      // Insert new junction rows
      if (targetIds && targetIds.length > 0) {
        for (const targetId of targetIds) {
          const placeholder1 = this.dialect === 'pg' ? '$1' : '?'
          const placeholder2 = this.dialect === 'pg' ? '$2' : '?'
          const sql = `INSERT INTO ${qualifiedTable} ("${meta.sourceColumn}", "${meta.targetColumn}") VALUES (${placeholder1}, ${placeholder2})`
          await this.executor.execute([sql, [entityId, targetId]])
        }
      }
    }
  }
}

