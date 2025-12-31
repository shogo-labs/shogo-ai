/**
 * DDL Generator Main API
 *
 * This module provides the main entry point for generating SQL DDL (Data Definition Language)
 * statements from Enhanced JSON Schema. It orchestrates the entire DDL generation process:
 * - Topological sorting to determine table creation order
 * - Entity table generation via table-generator
 * - Junction table generation for many-to-many relationships
 * - Foreign key constraint collection
 *
 * The generateDDL() function is the primary API that transforms a complete Enhanced JSON Schema
 * into a structured DDLOutput containing all necessary SQL definitions.
 *
 * @module ddl
 */

import type { DDLOutput, SqlDialect, TableDef, ForeignKeyDef, DDLGenerationConfig } from "./types"
import { topologicalSort, toSnakeCase } from "./utils"
import { generateCreateTable } from "./table-generator"
import { generateJunctionTable } from "./junction-generator"
import { qualifyTableName, type QualifyDialect } from "./namespace"

/**
 * Generates complete DDL output from Enhanced JSON Schema
 *
 * This is the main entry point for the DDL generator. It transforms an Enhanced JSON Schema
 * with entity definitions into a complete set of SQL DDL structures including:
 * - Entity tables with columns and constraints
 * - Junction tables for many-to-many relationships
 * - Foreign key constraints
 * - Topologically sorted execution order
 *
 * The generation process:
 * 1. Extract model definitions from schema.definitions
 * 2. Compute topological sort based on FK dependencies
 * 3. Generate CREATE TABLE definitions for each entity model
 * 4. Generate junction tables for array reference properties
 * 5. Collect all foreign keys into a unified array
 * 6. Return structured DDLOutput
 *
 * Execution order considerations:
 * - Tables with no FK dependencies appear first
 * - Tables are ordered to satisfy referential integrity during creation
 * - Junction tables appear after their referenced entity tables
 * - Self-referential FKs do not affect ordering
 *
 * Foreign key handling:
 * - PostgreSQL: FK constraints returned separately for ALTER TABLE statements
 * - SQLite: FK constraints can be applied inline during CREATE TABLE
 * - All FKs collected in foreignKeys array regardless of dialect
 *
 * @param {any} schema - Enhanced JSON Schema with definitions containing entity models
 * @param {SqlDialect} dialect - SQL dialect for type mapping and identifier escaping
 * @returns {DDLOutput} Complete DDL output with tables, FKs, junction tables, and execution order
 *
 * @example
 * ```ts
 * const schema = {
 *   definitions: {
 *     Organization: {
 *       type: "object",
 *       properties: {
 *         id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
 *         name: { type: "string" }
 *       },
 *       required: ["name"]
 *     },
 *     Team: {
 *       type: "object",
 *       properties: {
 *         id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
 *         name: { type: "string" },
 *         organizationId: {
 *           type: "string",
 *           "x-reference-type": "single",
 *           "x-reference-target": "Organization"
 *         }
 *       },
 *       required: ["name", "organizationId"]
 *     }
 *   }
 * }
 *
 * const dialect = createPostgresDialect()
 * const ddl = generateDDL(schema, dialect)
 *
 * // ddl.executionOrder => ["Organization", "Team"]
 * // ddl.tables => [TableDef for Organization, TableDef for Team]
 * // ddl.foreignKeys => [FK from Team to Organization]
 * // ddl.junctionTables => []
 * ```
 */
export function generateDDL(schema: any, dialect: SqlDialect, config?: DDLGenerationConfig): DDLOutput {
  // 1. Extract model definitions from schema (supports both definitions and $defs)
  const models = schema.definitions || schema.$defs || {}
  const modelNames = Object.keys(models)
  const namespace = config?.namespace

  // Determine dialect name for qualifyTableName
  const dialectName: QualifyDialect = dialect.name === "sqlite" ? "sqlite" : "postgresql"

  // 2. Compute topological sort for table creation order
  // Convert model names to qualified table names (with namespace if provided)
  const sortedModels = topologicalSort(models)
  const executionOrder = sortedModels.map((modelName) => {
    const baseTableName = toSnakeCase(modelName)
    return namespace ? qualifyTableName(namespace, baseTableName, dialectName) : baseTableName
  })

  // 3. Generate entity tables
  const tables: TableDef[] = []
  const allForeignKeys: ForeignKeyDef[] = []

  for (const modelName of modelNames) {
    const model = models[modelName]
    const tableDef = generateCreateTable(model, modelName, dialect, namespace, models)

    tables.push(tableDef)

    // Collect foreign keys from entity tables
    if (tableDef.foreignKeys.length > 0) {
      allForeignKeys.push(...tableDef.foreignKeys)
    }
  }

  // 4. Generate junction tables for many-to-many relationships
  const junctionTables: TableDef[] = []

  for (const modelName of modelNames) {
    const model = models[modelName]
    const properties = model.properties || {}

    for (const propName in properties) {
      const prop = properties[propName]

      // Generate junction table for array references
      const junctionTable = generateJunctionTable(
        modelName,
        { name: propName, ...prop },
        dialect,
        namespace,
        models
      )

      if (junctionTable) {
        junctionTables.push(junctionTable)

        // Collect foreign keys from junction tables
        if (junctionTable.foreignKeys.length > 0) {
          allForeignKeys.push(...junctionTable.foreignKeys)
        }

        // Add junction table to execution order (after its referenced tables)
        executionOrder.push(junctionTable.name)
      }
    }
  }

  // 5. Return complete DDL output
  return {
    tables,
    foreignKeys: allForeignKeys,
    junctionTables,
    executionOrder,
    namespace,
  }
}

// Re-export types and utilities for convenience
export type { DDLOutput, TableDef, ColumnDef, ForeignKeyDef, SqlDialect, DDLGenerationConfig } from "./types"

// Re-export migration types
export type {
  SchemaDiff,
  ModelDiff,
  ColumnModification,
  MigrationOutput,
  MigrationOperationDef,
  MigrationRecord,
} from "./migration-types"
export { MigrationOperation } from "./migration-types"

// Re-export diff detection
export { compareSchemas } from "./diff"

// Re-export migration generator
export { generateMigration, migrationOutputToSQL, type MigrationConfig } from "./migration-generator"
export type { DDLGenerationOptions } from "./sql-generator"
export { createPostgresDialect, createSqliteDialect } from "./dialect"
export { topologicalSort } from "./utils"
export {
  columnDefToSQL,
  tableDefToCreateTableSQL,
  foreignKeyDefToSQL,
  ddlOutputToSQL,
  generateSQL,
} from "./sql-generator"
export { deriveNamespace, qualifyTableName, type QualifyDialect } from "./namespace"

// Re-export migration tracker functions
export {
  getAppliedMigrations,
  getLatestMigration,
  isMigrationApplied,
  recordMigration,
  computeSchemaChecksum,
} from "./migration-tracker"
