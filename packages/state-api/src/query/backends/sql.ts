/**
 * SQL Backend Implementation
 *
 * Compiles MongoDB-style queries to PostgreSQL using @ucast/sql.
 * Provides parameterized query generation for safe SQL execution.
 *
 * @module query/backends/sql
 *
 * Requirements:
 * - REQ-03: Backend abstraction with SQL compilation
 * - SQL-01: Translate all operators to SQL equivalents
 * - SQL-02: Generate parameterized queries (SQL injection safe)
 * - SQL-03: Support orderBy with column mapping
 * - SQL-04: Support LIMIT/OFFSET pagination
 * - SQL-05: Optimize count() to use COUNT(*)
 * - SQL-06: Optimize any() to use EXISTS
 * - SQL-08: Declare capabilities via BackendCapabilities
 *
 * Design decisions:
 * - Uses @ucast/sql with PostgreSQL dialect (pg)
 * - Custom $contains interpreter compiles to LIKE with parameterized wildcards
 * - Manual ORDER BY/LIMIT/OFFSET construction (not part of @ucast/sql)
 * - joinRelation callback returns false (consumer handles JOINs)
 * - Returns [sql, params, joins] tuple for maximum flexibility
 *
 * KNOWN LIMITATIONS:
 * - $eq: null generates = NULL instead of IS NULL (limitation of @ucast/sql)
 *   Workaround: Use custom $isNull operator or post-process SQL
 * - Auto-joins not supported: joinRelation returns false, consumer must add JOIN clauses
 * - Only WHERE clause generation: SELECT/FROM/JOIN must be built by consumer
 */

import type { Condition } from '@ucast/core'
import {
  createSqlInterpreter,
  allInterpreters,
  pg,
  sqlite,
  type SqlOperator,
} from '@ucast/sql'
import type { FieldCondition } from '@ucast/core'
import { parseQuery } from '../ast'
import type { IBackend, BackendCapabilities, QueryOptions, QueryResult, DDLGenerationOptions, DDLExecutionResult, CompileContext, ModelResolver } from './types'
import type { SubqueryCondition } from '../ast/types'
import type { ISqlExecutor } from '../execution/types'
import { generateDDL, ddlOutputToSQL, createPostgresDialect, createSqliteDialect } from '../../ddl'

// ============================================================================
// Dialect Types
// ============================================================================

export type SqlDialect = 'pg' | 'sqlite'

// ============================================================================
// Custom Operators
// ============================================================================

/**
 * Custom $contains interpreter for SQL.
 * Compiles to LIKE with parameterized wildcards.
 *
 * @example
 * Input:  { name: { $contains: 'test' } }
 * Output: "name" LIKE $1  (params: ['%test%'])
 */
const contains: SqlOperator<FieldCondition<string>> = (condition, query) => {
  // Wrap value in wildcards for substring matching
  // @ucast/sql will parameterize this correctly
  return query.where(condition.field, 'LIKE', `%${condition.value}%`)
}

// ============================================================================
// SQL Interpreter Setup
// ============================================================================

/**
 * Create SQL interpreter with extended operators.
 * Includes all standard @ucast/sql interpreters plus custom $contains.
 */
const interpret = createSqlInterpreter({
  ...allInterpreters,
  contains,
})

/**
 * Create dialect options with join tracking.
 *
 * @param dialect - SQL dialect ('pg' or 'sqlite')
 * @param joinTracker - Array to collect required join names
 * @returns Dialect options with joinRelation callback
 */
function createDialectOptions(dialect: SqlDialect, joinTracker: string[]) {
  const baseDialect = dialect === 'sqlite' ? sqlite : pg

  return {
    ...baseDialect,
    // Track required joins but don't auto-generate JOIN clauses
    // Consumer is responsible for constructing complete query with JOINs
    joinRelation: (relationName: string) => {
      joinTracker.push(relationName)
      return false // Signal we won't auto-generate the join
    },
  }
}

// ============================================================================
// SqlBackend Class
// ============================================================================

/**
 * SQL query compilation backend using @ucast/sql.
 *
 * @remarks
 * This backend compiles MongoDB-style queries to PostgreSQL-compatible SQL.
 * It generates parameterized queries for SQL injection safety.
 *
 * The backend returns SQL fragments (WHERE clause only), not complete queries.
 * Consumer must wrap in SELECT/FROM and add JOIN clauses as needed.
 *
 * @example
 * ```typescript
 * const backend = new SqlBackend()
 * const ast = parseQuery({ age: { $gt: 18 }, status: 'active' })
 * const [sql, params, joins] = backend.compileSelect(ast, 'users', {
 *   orderBy: { field: 'name', direction: 'asc' },
 *   take: 10,
 *   skip: 20
 * })
 *
 * // Complete query construction:
 * const fullQuery = `SELECT * FROM users WHERE ${sql} ORDER BY ... LIMIT ... OFFSET ...`
 * // Execute with params to prevent SQL injection
 * ```
 */
export class SqlBackend implements IBackend {
  /**
   * SQL dialect for this backend instance.
   * Determines placeholder style, identifier escaping, and dialect-specific quirks.
   */
  readonly dialect: SqlDialect

  /**
   * Optional SQL executor for database access.
   * When provided, enables BackendRegistry to create SqlQueryExecutor.
   */
  readonly executor?: ISqlExecutor

  /**
   * Declares the operators and features supported by this backend.
   */
  readonly capabilities: BackendCapabilities = {
    operators: [
      'eq', 'ne',
      'gt', 'gte', 'lt', 'lte',
      'in', 'nin',
      'regex', 'contains',
      'and', 'or', 'not'
    ],
    features: {
      sorting: true,
      pagination: true,
      relations: false,  // Consumer handles JOINs
      parameterized: true,
    }
  }

  /**
   * Create a new SqlBackend.
   *
   * @param config - Either a dialect string or config object with dialect and executor
   *
   * @example
   * ```typescript
   * // String form (backward compatible)
   * const backend = new SqlBackend('sqlite')
   *
   * // Config form (with executor)
   * const backend = new SqlBackend({
   *   dialect: 'sqlite',
   *   executor: new BunSqlExecutor(db)
   * })
   * ```
   */
  constructor(config?: SqlDialect | { dialect?: SqlDialect; executor?: ISqlExecutor }) {
    if (typeof config === 'string') {
      // String form: just dialect
      this.dialect = config
    } else if (config && typeof config === 'object') {
      // Object form: dialect and executor
      this.dialect = config.dialect ?? 'pg'
      this.executor = config.executor
    } else {
      // No config: default to pg
      this.dialect = 'pg'
    }
  }

  /**
   * Execute query against collection.
   *
   * @remarks
   * SqlBackend doesn't execute queries directly - it compiles them to SQL.
   * This method is required by IBackend interface but throws an error.
   * Use compileSelect(), compileCount(), or compileExists() instead.
   *
   * @throws Error always - use compilation methods instead
   */
  async execute<T>(
    ast: Condition,
    collection: T[],
    options?: QueryOptions
  ): Promise<QueryResult<T>> {
    throw new Error(
      'SqlBackend.execute() is not implemented. ' +
      'Use compileSelect(), compileCount(), or compileExists() to generate SQL, ' +
      'then execute against your database.'
    )
  }

  /**
   * Compile a SELECT query with WHERE clause, ORDER BY, and LIMIT/OFFSET.
   *
   * @param ast - Query AST (from parseQuery)
   * @param tableName - Table name to query
   * @param options - Optional ordering and pagination
   * @returns Tuple of [sql, params, joins]
   *
   * @remarks
   * Returns SQL fragment (WHERE clause only). Consumer must construct complete query:
   * ```sql
   * SELECT * FROM tableName WHERE {sql} ORDER BY ... LIMIT ... OFFSET ...
   * ```
   *
   * @example
   * ```typescript
   * const ast = parseQuery({ age: { $gt: 18 } })
   * const [sql, params, joins] = backend.compileSelect(ast, 'users', {
   *   orderBy: { field: 'createdAt', direction: 'desc' },
   *   take: 10
   * })
   * // sql: '"age" > $1 ORDER BY "createdAt" DESC LIMIT 10'
   * // params: [18]
   * // joins: []
   * ```
   */
  compileSelect(
    ast: Condition | SubqueryCondition,
    tableName: string,
    options?: QueryOptions,
    context?: CompileContext
  ): [string, any[], string[]] {
    // Track required joins - pass through context to compileCondition
    const joins: string[] = []

    // Compile WHERE clause using dialect-specific options
    // Use new compilation path that handles subqueries
    // Pass joins array through context so joinRelation callback can populate it
    const [whereSql, params] = this.compileCondition(ast, { ...context, joins })

    // Note: whereSql may be "()" for empty conditions - caller (buildSelectSql) handles this
    const parts: string[] = [whereSql]

    // ORDER BY clause (manual construction)
    if (options?.orderBy) {
      const orderClauses = Array.isArray(options.orderBy)
        ? options.orderBy
        : [options.orderBy]

      const orderBySql = orderClauses
        .map(({ field, direction }) =>
          `${this.escapeIdentifier(field)} ${direction.toUpperCase()}`
        )
        .join(', ')

      parts.push(`ORDER BY ${orderBySql}`)
    }

    // LIMIT clause (manual construction)
    // SQLite quirk: OFFSET requires LIMIT, so add LIMIT -1 if skip without take
    if (options?.take !== undefined) {
      parts.push(`LIMIT ${options.take}`)
    } else if (options?.skip !== undefined && this.dialect === 'sqlite') {
      parts.push('LIMIT -1')  // SQLite: -1 means no limit
    }

    // OFFSET clause (manual construction)
    if (options?.skip !== undefined) {
      parts.push(`OFFSET ${options.skip}`)
    }

    return [parts.join(' '), params, joins]
  }

  /**
   * Compile a COUNT(*) query.
   *
   * @param ast - Query AST (from parseQuery)
   * @param tableName - Table name to query
   * @returns Tuple of [sql, params, joins]
   *
   * @remarks
   * Generates complete COUNT(*) query with WHERE clause.
   * Does not include ORDER BY or LIMIT (not needed for counting).
   *
   * @example
   * ```typescript
   * const ast = parseQuery({ status: 'active' })
   * const [sql, params] = backend.compileCount(ast, 'users')
   * // sql: 'SELECT COUNT(*) FROM "users" WHERE "status" = $1'
   * // params: ['active']
   * ```
   */
  compileCount(
    ast: Condition | SubqueryCondition,
    tableName: string,
    context?: CompileContext
  ): [string, any[], string[]] {
    // Track required joins - pass through context to compileCondition
    const joins: string[] = []

    // COUNT queries don't need ORDER BY or LIMIT
    // Use new compilation path that handles subqueries
    // Pass joins array through context so joinRelation callback can populate it
    const [whereSql, params] = this.compileCondition(ast, { ...context, joins })

    // Handle empty WHERE clause
    let sql: string
    if (whereSql.trim() === '()' || whereSql.trim() === '') {
      sql = `SELECT COUNT(*) FROM ${this.escapeIdentifier(tableName)}`
    } else {
      sql = `SELECT COUNT(*) FROM ${this.escapeIdentifier(tableName)} WHERE ${whereSql}`
    }

    return [sql, params, joins]
  }

  /**
   * Compile an EXISTS query for efficient existence checks.
   *
   * @param ast - Query AST (from parseQuery)
   * @param tableName - Table name to query
   * @param context - Optional compile context with ModelResolver for subqueries
   * @returns Tuple of [sql, params, joins]
   *
   * @remarks
   * Generates optimized query using LIMIT 1 for early termination.
   * Returns complete query with SELECT 1 pattern for boolean result.
   *
   * @example
   * ```typescript
   * const ast = parseQuery({ email: 'test@example.com' })
   * const [sql, params] = backend.compileExists(ast, 'users')
   * // sql: 'SELECT 1 FROM "users" WHERE "email" = $1 LIMIT 1'
   * // params: ['test@example.com']
   * ```
   */
  compileExists(
    ast: Condition | SubqueryCondition,
    tableName: string,
    context?: CompileContext
  ): [string, any[], string[]] {
    // Track required joins - pass through context to compileCondition
    const joins: string[] = []

    // EXISTS queries should LIMIT 1 for efficiency
    // Use new compilation path that handles subqueries
    // Pass joins array through context so joinRelation callback can populate it
    const [whereSql, params] = this.compileCondition(ast, { ...context, joins })

    // Handle empty WHERE clause
    let sql: string
    if (whereSql.trim() === '()' || whereSql.trim() === '') {
      sql = `SELECT 1 FROM ${this.escapeIdentifier(tableName)} LIMIT 1`
    } else {
      sql = `SELECT 1 FROM ${this.escapeIdentifier(tableName)} WHERE ${whereSql} LIMIT 1`
    }

    return [sql, params, joins]
  }

  /**
   * Compile just the WHERE clause from an AST.
   *
   * @param ast - Query AST (from parseQuery)
   * @param context - Optional compile context with ModelResolver for subqueries
   * @returns Tuple of [whereClause, params]
   *
   * @remarks
   * Used by mutation operations (updateMany, deleteMany) that need
   * WHERE clause compilation without SELECT/ORDER BY/LIMIT.
   *
   * Supports SubqueryCondition nodes when ModelResolver is provided:
   * ```typescript
   * { authorId: { $in: { $query: { model: 'User', filter: { role: 'admin' } } } } }
   * // Compiles to: "author_id" IN (SELECT "id" FROM "users" WHERE "role" = $1)
   * ```
   *
   * @example
   * ```typescript
   * const ast = parseQuery({ status: 'active' })
   * const [whereClause, params] = backend.compileWhere(ast)
   * // whereClause: '"status" = $1'
   * // params: ['active']
   * ```
   */
  compileWhere(ast: Condition | SubqueryCondition, context?: CompileContext): [string, any[]] {
    // Use new compilation method that handles subqueries
    const [sql, params] = this.compileCondition(ast, context ?? {})

    // Convert "()" (empty compound) to "" for callers that use this directly in SQL
    // Note: compileSelect handles "()" separately via buildSelectSql in the executor
    if (sql.trim() === '()' || sql.trim() === '') {
      return ['', params]
    }

    return [sql, params]
  }

  /**
   * Compile a condition (regular or subquery) to SQL.
   *
   * @param ast - Query AST (Condition or SubqueryCondition)
   * @param context - Compile context with ModelResolver, paramOffset, dialect, joins
   * @returns Tuple of [sql, params]
   */
  private compileCondition(
    ast: Condition | SubqueryCondition,
    context: CompileContext
  ): [string, any[]] {
    // Check if this is a SubqueryCondition
    if (this.isSubqueryCondition(ast)) {
      return this.compileSubqueryCondition(ast, context)
    }

    // Check if this is a CompoundCondition that might contain subqueries
    if (this.isCompoundCondition(ast)) {
      return this.compileCompoundWithSubqueries(ast, context)
    }

    // Regular condition - delegate to @ucast/sql interpreter
    // Use joins from context if provided, otherwise create local array
    const joins = context.joins ?? []
    const [whereSql, params] = interpret(ast as Condition, createDialectOptions(this.dialect, joins))

    // Note: @ucast/sql returns "()" for empty conditions (e.g., parseQuery({}))
    // Callers handle this case (e.g., compileCount checks for "()" or "")
    return [whereSql, params]
  }

  /**
   * Check if an AST node is a SubqueryCondition.
   */
  private isSubqueryCondition(ast: any): ast is SubqueryCondition {
    return ast && typeof ast === 'object' && ast.type === 'subquery'
  }

  /**
   * Check if an AST node is a CompoundCondition.
   */
  private isCompoundCondition(ast: any): boolean {
    return ast && typeof ast === 'object' && 'value' in ast && Array.isArray(ast.value)
  }

  /**
   * Compile a SubqueryCondition to SQL.
   *
   * @param ast - SubqueryCondition node
   * @param context - Compile context with ModelResolver
   * @returns Tuple of [sql, params]
   */
  private compileSubqueryCondition(
    ast: SubqueryCondition,
    context: CompileContext
  ): [string, any[]] {
    const { modelResolver } = context

    if (!modelResolver) {
      throw new Error(
        'ModelResolver required for subquery compilation. ' +
        'Pass a CompileContext with modelResolver when compiling queries with subqueries.'
      )
    }

    const { field, operator, subquery } = ast
    const { model, filter, selectField } = subquery

    // Get table and column names from resolver
    const tableName = modelResolver.getTableName(model)
    const selectColumn = this.escapeIdentifier(selectField)

    // Compile inner filter if present
    let innerWhereSql = ''
    let allParams: any[] = []

    if (filter) {
      // Normalize the inner filter field names using the ModelResolver
      const normalizedFilter = this.normalizeSubqueryFilter(filter, model, modelResolver)

      const [innerSql, innerParams] = this.compileCondition(normalizedFilter, {
        ...context,
        paramOffset: (context.paramOffset ?? 0) + allParams.length
      })

      if (innerSql) {
        innerWhereSql = ` WHERE ${innerSql}`
        allParams = innerParams
      }
    }

    // Build the subquery
    const subquerySql = `SELECT ${selectColumn} FROM ${tableName}${innerWhereSql}`

    // Build the full condition
    const escapedField = this.escapeIdentifier(field)
    const inOperator = operator === 'nin' ? 'NOT IN' : 'IN'
    const fullSql = `${escapedField} ${inOperator} (${subquerySql})`

    return [fullSql, allParams]
  }

  /**
   * Normalize field names in a subquery filter using the ModelResolver.
   * Recursively transforms all FieldCondition and SubqueryCondition nodes.
   *
   * @param filter - The filter AST to normalize
   * @param modelName - The model name for this filter's context
   * @param resolver - The ModelResolver to use for field name resolution
   * @returns Normalized filter with snake_case field names
   */
  private normalizeSubqueryFilter(
    filter: Condition | SubqueryCondition,
    modelName: string,
    resolver: ModelResolver
  ): Condition | SubqueryCondition {
    // Handle SubqueryCondition - normalize outer field but don't normalize inner filter here
    // (it will be normalized recursively when that subquery is compiled)
    if (this.isSubqueryCondition(filter)) {
      return {
        type: 'subquery',
        field: resolver.getColumnName(modelName, filter.field),
        operator: filter.operator,
        subquery: filter.subquery  // Inner filter normalized when this subquery is compiled
      } as SubqueryCondition
    }

    // Handle FieldCondition (has 'field' property)
    if ('field' in filter && typeof (filter as any).field === 'string') {
      const fc = filter as any
      const normalizedField = resolver.getColumnName(modelName, fc.field)
      // Import FieldCondition from @ucast/core at top of file
      return new (filter.constructor as any)(fc.operator, normalizedField, fc.value)
    }

    // Handle CompoundCondition (has 'value' array)
    if ('value' in filter && Array.isArray((filter as any).value)) {
      const cc = filter as any
      const normalizedChildren = cc.value.map((child: Condition | SubqueryCondition) =>
        this.normalizeSubqueryFilter(child, modelName, resolver)
      )
      return new (filter.constructor as any)(cc.operator, normalizedChildren)
    }

    // Return as-is if not recognized
    return filter
  }

  /**
   * Compile a CompoundCondition that may contain SubqueryConditions.
   *
   * @param ast - CompoundCondition node
   * @param context - Compile context
   * @returns Tuple of [sql, params]
   */
  private compileCompoundWithSubqueries(
    ast: any,
    context: CompileContext
  ): [string, any[]] {
    const operator = ast.operator as string
    const children = ast.value as any[]

    // Check if any child is a subquery
    const hasSubquery = children.some(child => this.isSubqueryCondition(child))

    if (!hasSubquery) {
      // No subqueries - delegate to standard interpreter
      // Use joins from context if provided
      const joins = context.joins ?? []
      const [whereSql, params] = interpret(ast as Condition, createDialectOptions(this.dialect, joins))

      // Note: Returns "()" for empty compound conditions
      // Callers handle this case appropriately
      return [whereSql, params]
    }

    // Has subqueries - compile each child individually
    const allParams: any[] = []
    const compiledParts: string[] = []

    for (const child of children) {
      const [childSql, childParams] = this.compileCondition(child, {
        ...context,
        paramOffset: (context.paramOffset ?? 0) + allParams.length
      })

      // Skip empty SQL (but "()" is not empty)
      if (childSql && childSql.trim() !== '' && childSql.trim() !== '()') {
        compiledParts.push(childSql)
        allParams.push(...childParams)
      }
    }

    // Handle empty result (no children compiled to SQL)
    if (compiledParts.length === 0) {
      return ['()', []]  // Return "()" for consistency with @ucast/sql
    }

    // Join with operator
    const sqlOperator = operator.toUpperCase()
    if (sqlOperator === 'NOT') {
      // NOT has single child
      return [`NOT (${compiledParts[0]})`, allParams]
    }

    const joinedSql = compiledParts.map(part => `(${part})`).join(` ${sqlOperator} `)
    return [joinedSql, allParams]
  }

  /**
   * Escape SQL identifier (table or column name).
   *
   * @param name - Identifier to escape
   * @returns Quoted identifier safe for SQL
   *
   * @remarks
   * PostgreSQL uses double quotes, SQLite/MySQL use backticks.
   * Handles quote escaping by doubling quotes or escaping backticks.
   *
   * @example
   * ```typescript
   * // PostgreSQL:
   * escapeIdentifier('firstName')  // "firstName"
   * escapeIdentifier('user"name')  // "user""name"
   *
   * // SQLite:
   * escapeIdentifier('firstName')  // `firstName`
   * escapeIdentifier('user`name')  // `user``name`
   * ```
   */
  private escapeIdentifier(name: string): string {
    if (this.dialect === 'sqlite') {
      // SQLite uses backticks for identifiers
      // Escape existing backticks by doubling them
      return `\`${name.replace(/`/g, '``')}\``
    } else {
      // PostgreSQL uses double quotes for identifiers
      // Check if already a qualified name like "schema"."table" (from qualifyTableName)
      if (name.startsWith('"') && name.includes('"."')) {
        return name // Already escaped qualified name
      }
      // Escape existing quotes by doubling them
      return `"${name.replace(/"/g, '""')}"`
    }
  }

  /**
   * Execute DDL statements against this backend's database.
   *
   * @param schema - Enhanced JSON Schema with model definitions
   * @param options - DDL generation options (ifNotExists, etc.)
   * @returns Promise resolving to DDL execution result
   *
   * @remarks
   * - Generates DDL using backend's dialect (pg or sqlite)
   * - Executes via backend's executor if available
   * - Returns generated statements even if execution fails
   * - Requires executor to be configured for actual execution
   *
   * @example
   * ```typescript
   * const backend = new SqlBackend({
   *   dialect: 'pg',
   *   executor: new PostgresExecutor(pool)
   * })
   *
   * const result = await backend.executeDDL(schema, { ifNotExists: true })
   * if (result.success) {
   *   console.log(`Executed ${result.executed} statements`)
   * } else {
   *   console.error(`DDL failed: ${result.error}`)
   * }
   * ```
   */
  async executeDDL(
    schema: any,
    options?: DDLGenerationOptions
  ): Promise<DDLExecutionResult> {
    // 1. Select dialect for DDL generation
    const ddlDialect = this.dialect === 'sqlite'
      ? createSqliteDialect()
      : createPostgresDialect()

    // 2. Generate DDL output from schema with namespace
    const ddlOutput = generateDDL(schema, ddlDialect, { namespace: options?.namespace })

    // 3. Convert to SQL statements
    const statements = ddlOutputToSQL(ddlOutput, ddlDialect, {
      ifNotExists: options?.ifNotExists ?? true
    })

    // 4. Check for executor
    const executor = this.executor
    if (!executor) {
      return {
        success: false,
        statements,
        executed: 0,
        error: 'No executor configured for SqlBackend - cannot execute DDL statements'
      }
    }

    // 5. Execute statements via executor (executeMany is required for DDL execution)
    try {
      await executor.executeMany!(statements)
      return {
        success: true,
        statements,
        executed: statements.length
      }
    } catch (err: any) {
      return {
        success: false,
        statements,
        executed: 0,
        error: err.message || String(err)
      }
    }
  }
}
