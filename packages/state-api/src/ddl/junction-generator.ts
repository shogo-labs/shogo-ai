/**
 * DDL junction table generator
 *
 * This module generates junction tables for many-to-many relationships.
 * Junction tables are created for properties with x-reference-type: "array"
 * and contain two foreign key columns linking the source and target entities.
 *
 * Junction table structure:
 * - Table name: {SourceModel}_{propertyName} (e.g., Team_members)
 * - Columns: {source}_id and {target}_id, both NOT NULL
 * - Foreign keys: Both columns reference their respective tables with CASCADE delete
 * - Primary key: Composite key on ({source}_id, {target}_id)
 *
 * @module ddl/junction-generator
 */

import type { TableDef, ColumnDef, ForeignKeyDef, SqlDialect } from "./types"
import { toSnakeCase } from "./utils"

/**
 * Generates a junction table definition for a many-to-many relationship
 *
 * Creates a junction table (also called a join table or bridge table) for properties
 * with x-reference-type: "array". The junction table contains two foreign key columns
 * that link the source model to the target model, enabling many-to-many relationships.
 *
 * Properties are skipped if:
 * - x-reference-type is not "array"
 * - x-computed is true (computed/inverse relationships are not stored)
 * - x-reference-target is missing
 *
 * Naming convention:
 * - Table: {SourceModel}_{propertyName}
 * - Columns: {source_snake_case}_id, {target_snake_case}_id
 * - Constraints: fk_{table}_{column}
 *
 * Both foreign keys use ON DELETE CASCADE to maintain referential integrity
 * when either the source or target entity is deleted.
 *
 * @param {string} sourceModelName - Name of the source model (e.g., "Team")
 * @param {any} property - Property definition with name attached
 * @param {SqlDialect} dialect - SQL dialect for type mapping and identifier escaping
 * @returns {TableDef | null} Junction table definition or null if property should be skipped
 *
 * @example
 * ```ts
 * const property = {
 *   name: "members",
 *   type: "array",
 *   items: { type: "string" },
 *   "x-reference-type": "array",
 *   "x-reference-target": "User"
 * }
 *
 * const table = generateJunctionTable("Team", property, postgresDialect)
 * // => {
 * //   name: "Team_members",
 * //   columns: [
 * //     { name: "team_id", type: "UUID", nullable: false },
 * //     { name: "user_id", type: "UUID", nullable: false }
 * //   ],
 * //   primaryKey: "team_id, user_id",
 * //   foreignKeys: [
 * //     { name: "fk_Team_members_team_id", table: "Team_members", column: "team_id",
 * //       referencesTable: "Team", referencesColumn: "id", onDelete: "CASCADE" },
 * //     { name: "fk_Team_members_user_id", table: "Team_members", column: "user_id",
 * //       referencesTable: "User", referencesColumn: "id", onDelete: "CASCADE" }
 * //   ]
 * // }
 * ```
 */
export function generateJunctionTable(
  sourceModelName: string,
  property: any,
  dialect: SqlDialect
): TableDef | null {
  // Skip computed properties (inverse relationships)
  if (property["x-computed"] === true) {
    return null
  }

  // Only process array references (many-to-many)
  if (property["x-reference-type"] !== "array") {
    return null
  }

  const targetModelName = property["x-reference-target"]
  if (!targetModelName) {
    return null
  }

  // Derive junction table name: {source_snake_case}_{propertyName}
  const sourceTableName = toSnakeCase(sourceModelName)
  const targetTableName = toSnakeCase(targetModelName)
  const junctionTableName = `${sourceTableName}_${property.name}`

  // Derive column names using snake_case convention
  const sourceColumnName = sourceTableName + "_id"
  const targetColumnName = targetTableName + "_id"

  // Determine SQL type for ID columns (typically UUID for string identifiers)
  // We assume identifiers are UUIDs (string + uuid format) as per the pattern in the codebase
  const idType = dialect.mapType("string", "uuid")

  // Create columns: both are NOT NULL
  const columns: ColumnDef[] = [
    {
      name: sourceColumnName,
      type: idType,
      nullable: false,
    },
    {
      name: targetColumnName,
      type: idType,
      nullable: false,
    },
  ]

  // Create foreign key constraints: both use ON DELETE CASCADE
  const foreignKeys: ForeignKeyDef[] = [
    {
      name: `fk_${junctionTableName}_${sourceColumnName}`,
      table: junctionTableName,
      column: sourceColumnName,
      referencesTable: sourceTableName,  // snake_case
      referencesColumn: "id",
      onDelete: "CASCADE",
    },
    {
      name: `fk_${junctionTableName}_${targetColumnName}`,
      table: junctionTableName,
      column: targetColumnName,
      referencesTable: targetTableName,  // snake_case
      referencesColumn: "id",
      onDelete: "CASCADE",
    },
  ]

  // Composite primary key on both columns
  const primaryKey = `${sourceColumnName}, ${targetColumnName}`

  return {
    name: junctionTableName,
    columns,
    primaryKey,
    foreignKeys,
  }
}
