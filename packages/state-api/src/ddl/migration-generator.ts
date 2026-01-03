/**
 * Migration Generator
 *
 * Transforms schema diffs into executable migration operations and SQL statements.
 *
 * @module ddl/migration-generator
 */

import type { SqlDialect, ColumnDef } from "./types"
import type {
  SchemaDiff,
  MigrationOutput,
  MigrationOperationDef,
} from "./migration-types"
import { MigrationOperation } from "./migration-types"
import { toSnakeCase } from "./utils"
import type { QualifyDialect } from "./namespace"

// ============================================================================
// Configuration Types
// ============================================================================

export interface MigrationConfig {
  /** Name of the schema being migrated */
  schemaName: string
  /** Target version number */
  version: number
  /** SQL namespace for table isolation */
  namespace?: string
}

// ============================================================================
// Migration Generation
// ============================================================================

/**
 * Generates migration operations from a schema diff.
 *
 * @param diff - Schema diff from compareSchemas()
 * @param dialect - SQL dialect for determining operation types
 * @param config - Migration configuration
 * @returns MigrationOutput with operations and warnings
 */
export function generateMigration(
  diff: SchemaDiff,
  dialect: SqlDialect,
  config: MigrationConfig
): MigrationOutput {
  const operations: MigrationOperationDef[] = []
  const warnings: string[] = []

  // Helper to get qualified table name (namespace prefix applied when namespace is provided)
  // Returns UNESCAPED name - escaping happens in migrationOutputToSQL
  const dialectName: QualifyDialect = dialect.name === "postgresql" || dialect.name === "postgres"
    ? "postgresql"
    : "sqlite"
  const qualify = (modelName: string): string => {
    const base = toSnakeCase(modelName)
    if (!config.namespace) return base
    // For SQLite: namespace__table (underscore separator)
    // For PostgreSQL: namespace.table (dot separator, escaping happens later)
    if (dialectName === "postgresql") {
      return `${config.namespace}.${base}`
    }
    return `${config.namespace}__${base}`
  }

  // Process added models (CREATE_TABLE)
  for (const modelName of diff.addedModels) {
    const tableName = qualify(modelName)
    operations.push({
      type: MigrationOperation.CREATE_TABLE,
      tableName,
      modelDef: modelName, // Store model name for later lookup
    })
  }

  // Process removed models (DROP_TABLE with warning)
  for (const modelName of diff.removedModels) {
    const tableName = qualify(modelName)
    operations.push({
      type: MigrationOperation.DROP_TABLE,
      tableName,
    })
    warnings.push(`DROP TABLE ${tableName}: Data loss warning - all data in this table will be deleted`)
  }

  // Process modified models (column changes)
  for (const modelDiff of diff.modifiedModels) {
    const tableName = qualify(modelDiff.modelName)

    // Check if any operation requires table recreation
    const needsRecreation = (
      modelDiff.removedColumns.length > 0 &&
      dialect.requiresTableRecreation(MigrationOperation.DROP_COLUMN)
    ) || (
      modelDiff.modifiedColumns.some(
        (mod) => mod.changeType === "type" && dialect.requiresTableRecreation(MigrationOperation.RECREATE_TABLE)
      )
    )

    if (needsRecreation) {
      // Generate RECREATE_TABLE operation
      // Columns = new columns from addedColumns + existing columns not in removedColumns
      const newColumns = modelDiff.addedColumns
      const existingColumns = modelDiff.modifiedColumns.map((m) => m.newDef)

      operations.push({
        type: MigrationOperation.RECREATE_TABLE,
        tableName,
        columns: [...newColumns, ...existingColumns],
      })

      if (modelDiff.removedColumns.length > 0) {
        warnings.push(
          `RECREATE TABLE ${tableName}: Data loss warning - columns ${modelDiff.removedColumns.join(", ")} will be dropped`
        )
      }
    } else {
      // Generate individual column operations

      // ADD_COLUMN for new columns
      for (const column of modelDiff.addedColumns) {
        operations.push({
          type: MigrationOperation.ADD_COLUMN,
          tableName,
          column,
        })

        // Warn if non-nullable without default
        if (!column.nullable && !column.defaultValue) {
          warnings.push(
            `ADD COLUMN ${tableName}.${column.name}: New non-nullable column without default. ` +
            `Consider making column nullable or adding a default value.`
          )
        }
      }

      // DROP_COLUMN for removed columns
      for (const columnName of modelDiff.removedColumns) {
        operations.push({
          type: MigrationOperation.DROP_COLUMN,
          tableName,
          columnName,
        })
        warnings.push(
          `DROP COLUMN ${tableName}.${columnName}: Data loss warning - all data in this column will be deleted`
        )
      }

      // Handle type changes (for PostgreSQL which supports ALTER COLUMN TYPE)
      for (const mod of modelDiff.modifiedColumns) {
        if (mod.changeType === "type") {
          warnings.push(
            `Type change ${tableName}.${mod.columnName}: ` +
            `${mod.oldDef.type} → ${mod.newDef.type}. ` +
            `Lossy type conversion may occur.`
          )
        }
      }
    }
  }

  return {
    version: config.version,
    schemaName: config.schemaName,
    diff,
    operations,
    warnings,
  }
}

// ============================================================================
// SQL Generation
// ============================================================================

/**
 * Escapes a qualified table name for the given dialect.
 *
 * For PostgreSQL qualified names like "namespace.table", escapes each part separately:
 * - Input: "my_schema.user" → Output: "my_schema"."user"
 *
 * For SQLite or unqualified names, just wraps in quotes:
 * - Input: "my_schema__user" → Output: "my_schema__user"
 * - Input: "user" → Output: "user"
 */
function escapeTableName(tableName: string, dialect: SqlDialect): string {
  // Check if this is a PostgreSQL-style qualified name (namespace.table)
  // PostgreSQL names use dot separator, SQLite uses double-underscore
  if (
    (dialect.name === "postgresql" || dialect.name === "postgres") &&
    tableName.includes(".") &&
    !tableName.startsWith('"') // Not already escaped
  ) {
    const [namespace, table] = tableName.split(".")
    return `${dialect.escapeIdentifier(namespace)}.${dialect.escapeIdentifier(table)}`
  }
  // Otherwise just escape as a single identifier
  return dialect.escapeIdentifier(tableName)
}

/**
 * Converts migration operations to SQL statements.
 *
 * @param output - Migration output from generateMigration()
 * @param dialect - SQL dialect for statement formatting
 * @returns Array of SQL statements to execute
 */
export function migrationOutputToSQL(
  output: MigrationOutput,
  dialect: SqlDialect
): string[] {
  const statements: string[] = []

  // Transaction start
  statements.push("BEGIN")

  for (const op of output.operations) {
    switch (op.type) {
      case MigrationOperation.CREATE_TABLE:
        // For CREATE_TABLE, we need to generate the full CREATE TABLE statement
        // This is handled separately since we need the model definition
        statements.push(
          `-- CREATE TABLE ${op.tableName} (requires model definition)`
        )
        break

      case MigrationOperation.DROP_TABLE:
        statements.push(
          `DROP TABLE ${escapeTableName(op.tableName, dialect)}`
        )
        break

      case MigrationOperation.ADD_COLUMN:
        if (op.column) {
          statements.push(generateAddColumnSQL(op.tableName, op.column, dialect))
        }
        break

      case MigrationOperation.DROP_COLUMN:
        if (op.columnName) {
          statements.push(generateDropColumnSQL(op.tableName, op.columnName, dialect))
        }
        break

      case MigrationOperation.RECREATE_TABLE:
        if (op.columns) {
          statements.push(...generateRecreateTableSQL(op.tableName, op.columns, dialect))
        }
        break
    }
  }

  // Transaction end
  statements.push("COMMIT")

  return statements
}

/**
 * Generates ALTER TABLE ADD COLUMN SQL.
 */
function generateAddColumnSQL(
  tableName: string,
  column: ColumnDef,
  dialect: SqlDialect
): string {
  const escapedTable = escapeTableName(tableName, dialect)
  const escapedColumn = dialect.escapeIdentifier(column.name)
  const type = column.type

  let sql = `ALTER TABLE ${escapedTable} ADD COLUMN ${escapedColumn} ${type}`

  if (!column.nullable) {
    sql += " NOT NULL"
  }

  if (column.defaultValue) {
    sql += ` DEFAULT ${column.defaultValue}`
  }

  return sql
}

/**
 * Generates ALTER TABLE DROP COLUMN SQL.
 */
function generateDropColumnSQL(
  tableName: string,
  columnName: string,
  dialect: SqlDialect
): string {
  const escapedTable = escapeTableName(tableName, dialect)
  const escapedColumn = dialect.escapeIdentifier(columnName)

  return `ALTER TABLE ${escapedTable} DROP COLUMN ${escapedColumn}`
}

/**
 * Generates the 4-step table recreation pattern for SQLite.
 *
 * 1. CREATE TABLE tablename_new with new schema
 * 2. INSERT INTO tablename_new SELECT ... FROM tablename
 * 3. DROP TABLE tablename
 * 4. ALTER TABLE tablename_new RENAME TO tablename
 */
function generateRecreateTableSQL(
  tableName: string,
  columns: ColumnDef[],
  dialect: SqlDialect
): string[] {
  const statements: string[] = []
  const escapedTable = escapeTableName(tableName, dialect)
  const tempTable = escapeTableName(`${tableName}_new`, dialect)

  // Step 1: CREATE TABLE temp with new schema
  const columnDefs = columns.map((col) => {
    let def = `${dialect.escapeIdentifier(col.name)} ${col.type}`
    if (!col.nullable) def += " NOT NULL"
    if (col.defaultValue) def += ` DEFAULT ${col.defaultValue}`
    return def
  })

  statements.push(`CREATE TABLE ${tempTable} (${columnDefs.join(", ")})`)

  // Step 2: INSERT INTO temp SELECT from original
  // For new columns with defaults, use the default value
  // For existing columns, copy from original
  const selectCols = columns.map((col) => {
    if (col.defaultValue) {
      // Use default value for new columns
      return `COALESCE(${dialect.escapeIdentifier(col.name)}, ${col.defaultValue}) AS ${dialect.escapeIdentifier(col.name)}`
    }
    return dialect.escapeIdentifier(col.name)
  })

  statements.push(
    `INSERT INTO ${tempTable} SELECT ${selectCols.join(", ")} FROM ${escapedTable}`
  )

  // Step 3: DROP TABLE original
  statements.push(`DROP TABLE ${escapedTable}`)

  // Step 4: RENAME temp to original
  statements.push(`ALTER TABLE ${tempTable} RENAME TO ${escapeTableName(tableName, dialect)}`)

  return statements
}
