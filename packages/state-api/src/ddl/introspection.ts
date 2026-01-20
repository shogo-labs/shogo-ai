/**
 * Database Introspection Module
 *
 * Provides dialect-aware functions for discovering database tables and columns.
 * Used for migration verification and recovery operations.
 *
 * Supports:
 * - SQLite: Uses PRAGMA table_list and PRAGMA table_info
 * - PostgreSQL: Uses information_schema.tables and information_schema.columns
 *
 * @module ddl/introspection
 */

import type { ISqlExecutor } from "../query/execution/types"

/**
 * Column information returned by introspection.
 */
export interface ColumnInfo {
  /** Column name */
  name: string
  /** Column data type (database-specific format) */
  type: string
  /** Whether the column allows NULL values */
  nullable: boolean
}

/**
 * SQL dialect type for introspection queries.
 */
export type IntrospectionDialect = "sqlite" | "pg" | "postgres" | "postgresql"

/**
 * Detects the SQL dialect from an executor instance.
 *
 * Detection strategy:
 * 1. Check if executor has a 'dialect' property (SqlBackend pattern)
 * 2. Check if executor has a 'connection' property with type hints
 * 3. Try executing a dialect-specific query
 *
 * @param executor - SQL executor to detect dialect from
 * @returns Detected dialect or 'sqlite' as default
 */
export async function detectDialect(executor: ISqlExecutor): Promise<IntrospectionDialect> {
  // Check for explicit dialect property on executor or its underlying connection
  const execAny = executor as any

  // Direct dialect property
  if (execAny.dialect) {
    const dialect = execAny.dialect.toLowerCase()
    if (dialect === "pg" || dialect === "postgres" || dialect === "postgresql") {
      return "pg"
    }
    return "sqlite"
  }

  // Check connection for dialect hints
  if (execAny.connection) {
    const conn = execAny.connection
    // Bun.sql Postgres has specific properties
    if (typeof conn.unsafe === "function") {
      return "pg"
    }
    // bun:sqlite Database has query method that returns statements
    if (typeof conn.query === "function") {
      return "sqlite"
    }
  }

  // Fallback: try a SQLite-specific query
  try {
    await executor.execute(["SELECT 1 FROM sqlite_master LIMIT 1", []])
    return "sqlite"
  } catch {
    return "pg"
  }
}

/**
 * Get list of actual tables in a namespace (schema).
 *
 * @param namespace - Namespace/schema name WITHOUT trailing separator
 *                    e.g., "user_schema" NOT "user_schema__"
 *                    SQLite: internally constructs "user_schema__tablename"
 *                    PostgreSQL: queries schema named "user_schema"
 * @param executor - SQL executor to query database
 * @param dialect - Optional dialect (auto-detected if not provided)
 * @returns Array of logical table names (without namespace prefix)
 *
 * @example
 * ```ts
 * const tables = await getActualTables("user_schema", executor)
 * // Returns: ["user", "profile", "settings"]
 * ```
 */
export async function getActualTables(
  namespace: string,
  executor: ISqlExecutor,
  dialect?: IntrospectionDialect
): Promise<string[]> {
  const effectiveDialect = dialect ?? await detectDialect(executor)

  if (effectiveDialect === "sqlite") {
    return getActualTablesSqlite(namespace, executor)
  } else {
    return getActualTablesPostgres(namespace, executor)
  }
}

/**
 * Get actual tables from SQLite database.
 * SQLite uses flat naming with namespace__tablename pattern.
 */
async function getActualTablesSqlite(
  namespace: string,
  executor: ISqlExecutor
): Promise<string[]> {
  // Normalize namespace: add __ separator if not present
  const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`

  // SQLite: Use sqlite_master which is always available
  const rows = await executor.execute([
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE $1 AND name NOT LIKE 'sqlite_%'`,
    [`${prefix}%`]
  ])

  // Extract table names, removing namespace prefix
  return rows.map((row: any) => {
    const fullName = row.name as string
    // Remove namespace prefix to get logical table name
    if (fullName.startsWith(prefix)) {
      return fullName.slice(prefix.length)
    }
    return fullName
  })
}

/**
 * Get actual tables from PostgreSQL database.
 * PostgreSQL uses actual schemas, so namespace is the schema name.
 */
async function getActualTablesPostgres(
  namespace: string,
  executor: ISqlExecutor
): Promise<string[]> {
  // PostgreSQL: Query tables in the namespace schema (not 'public')
  // The namespace IS the schema name (e.g., "system_migrations")
  const rows = await executor.execute([
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type = 'BASE TABLE'`,
    [namespace]
  ])

  // Return table names directly (no prefix stripping for PostgreSQL)
  return rows.map((row: any) => row.table_name as string)
}

/**
 * Get column information for a specific table.
 *
 * @param namespace - Namespace/schema name WITHOUT trailing separator
 * @param tableName - Logical table name (without namespace prefix)
 * @param executor - SQL executor to query database
 * @param dialect - Optional dialect (auto-detected if not provided)
 * @returns Array of column information objects
 *
 * @example
 * ```ts
 * const columns = await getTableColumns("user_schema", "user", executor)
 * // Returns: [
 * //   { name: "id", type: "TEXT", nullable: false },
 * //   { name: "email", type: "TEXT", nullable: true }
 * // ]
 * ```
 */
export async function getTableColumns(
  namespace: string,
  tableName: string,
  executor: ISqlExecutor,
  dialect?: IntrospectionDialect
): Promise<ColumnInfo[]> {
  const effectiveDialect = dialect ?? await detectDialect(executor)

  if (effectiveDialect === "sqlite") {
    // SQLite: construct full table name with __ separator
    const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`
    const fullTableName = `${prefix}${tableName}`
    return getTableColumnsSqlite(fullTableName, executor)
  } else {
    // PostgreSQL: pass schema and table name separately
    return getTableColumnsPostgres(namespace, tableName, executor)
  }
}

/**
 * Get column information from SQLite database.
 */
async function getTableColumnsSqlite(
  tableName: string,
  executor: ISqlExecutor
): Promise<ColumnInfo[]> {
  // SQLite: Use PRAGMA table_info
  // Note: PRAGMA doesn't support parameterized queries, so we escape quotes
  const escapedTableName = tableName.replace(/'/g, "''")
  const rows = await executor.execute([
    `PRAGMA table_info('${escapedTableName}')`,
    []
  ])

  return rows.map((row: any) => {
    // In SQLite, a column is NOT nullable if:
    // 1. It has NOT NULL constraint (notnull = 1), OR
    // 2. It is a primary key (pk > 0) - INTEGER PRIMARY KEY implies NOT NULL
    // Note: TEXT PRIMARY KEY in SQLite technically allows NULL, but we treat
    // primary keys as NOT NULL for practical purposes
    const isPrimaryKey = row.pk > 0
    const hasNotNullConstraint = row.notnull === 1 || row.notnull === true

    return {
      name: row.name as string,
      type: row.type as string,
      nullable: !hasNotNullConstraint && !isPrimaryKey,
    }
  })
}

/**
 * Get column information from PostgreSQL database.
 * PostgreSQL uses actual schemas, so we query by schema name and table name separately.
 */
async function getTableColumnsPostgres(
  schemaName: string,
  tableName: string,
  executor: ISqlExecutor
): Promise<ColumnInfo[]> {
  // PostgreSQL: Use information_schema.columns with schema = namespace
  const rows = await executor.execute([
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1
       AND table_name = $2
     ORDER BY ordinal_position`,
    [schemaName, tableName]
  ])

  return rows.map((row: any) => ({
    name: row.column_name as string,
    type: row.data_type as string,
    nullable: row.is_nullable === "YES",
  }))
}

/**
 * Check if a specific table exists in the database.
 *
 * @param namespace - Namespace/schema name WITHOUT trailing separator
 * @param tableName - Logical table name (without namespace prefix)
 * @param executor - SQL executor to query database
 * @param dialect - Optional dialect (auto-detected if not provided)
 * @returns True if table exists, false otherwise
 */
export async function tableExists(
  namespace: string,
  tableName: string,
  executor: ISqlExecutor,
  dialect?: IntrospectionDialect
): Promise<boolean> {
  const effectiveDialect = dialect ?? await detectDialect(executor)

  if (effectiveDialect === "sqlite") {
    // SQLite: construct full table name with __ separator
    const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`
    const fullTableName = `${prefix}${tableName}`
    const rows = await executor.execute([
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $1`,
      [fullTableName]
    ])
    return rows.length > 0
  } else {
    // PostgreSQL: query schema and table name separately
    const rows = await executor.execute([
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name = $2`,
      [namespace, tableName]
    ])
    return rows.length > 0
  }
}

/**
 * Get all tables with their full qualified names.
 *
 * @param namespace - Namespace/schema name WITHOUT trailing separator
 * @param executor - SQL executor to query database
 * @param dialect - Optional dialect (auto-detected if not provided)
 * @returns Array of full table names:
 *          - SQLite: "namespace__tablename" format
 *          - PostgreSQL: "schema.tablename" format
 */
export async function getActualTablesFullNames(
  namespace: string,
  executor: ISqlExecutor,
  dialect?: IntrospectionDialect
): Promise<string[]> {
  const effectiveDialect = dialect ?? await detectDialect(executor)

  if (effectiveDialect === "sqlite") {
    // SQLite: normalize namespace and return full prefixed names
    const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`
    const rows = await executor.execute([
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE $1 AND name NOT LIKE 'sqlite_%'`,
      [`${prefix}%`]
    ])
    return rows.map((row: any) => row.name as string)
  } else {
    // PostgreSQL: query schema and return qualified schema.table format
    const rows = await executor.execute([
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1
         AND table_type = 'BASE TABLE'`,
      [namespace]
    ])
    // Return qualified names in schema.table format
    return rows.map((row: any) => `${namespace}.${row.table_name}`)
  }
}
