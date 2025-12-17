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
import type { IBackend, BackendCapabilities, QueryOptions, QueryResult } from './types'
import type { ISqlExecutor } from '../execution/types'

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
    ast: Condition,
    tableName: string,
    options?: QueryOptions
  ): [string, any[], string[]] {
    // Track required joins
    const joins: string[] = []

    // Compile WHERE clause using dialect-specific options
    const [whereSql, params] = interpret(ast, createDialectOptions(this.dialect, joins))

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
    ast: Condition,
    tableName: string
  ): [string, any[], string[]] {
    // Track required joins
    const joins: string[] = []

    // COUNT queries don't need ORDER BY or LIMIT
    const [whereSql, params] = interpret(ast, createDialectOptions(this.dialect, joins))

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
    ast: Condition,
    tableName: string
  ): [string, any[], string[]] {
    // Track required joins
    const joins: string[] = []

    // EXISTS queries should LIMIT 1 for efficiency
    const [whereSql, params] = interpret(ast, createDialectOptions(this.dialect, joins))

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
   * @returns Tuple of [whereClause, params]
   *
   * @remarks
   * Used by mutation operations (updateMany, deleteMany) that need
   * WHERE clause compilation without SELECT/ORDER BY/LIMIT.
   *
   * @example
   * ```typescript
   * const ast = parseQuery({ status: 'active' })
   * const [whereClause, params] = backend.compileWhere(ast)
   * // whereClause: '"status" = $1'
   * // params: ['active']
   * ```
   */
  compileWhere(ast: Condition): [string, any[]] {
    const joins: string[] = []
    const [whereSql, params] = interpret(ast, createDialectOptions(this.dialect, joins))

    // Handle empty WHERE clause (parseQuery({}))
    if (whereSql.trim() === '()' || whereSql.trim() === '') {
      return ['', []]
    }

    return [whereSql, params]
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
      // Escape existing quotes by doubling them
      return `"${name.replace(/"/g, '""')}"`
    }
  }
}
