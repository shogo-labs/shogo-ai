/**
 * DDL table generator
 *
 * This module generates CREATE TABLE statements for entities with columns,
 * constraints, and foreign keys from Enhanced JSON Schema models.
 *
 * The generator:
 * - Uses 1:1 table name mapping (no pluralization)
 * - Derives columns from properties using type-mapper
 * - Adds PRIMARY KEY constraint for identifier properties
 * - Adds NOT NULL constraints based on required array
 * - Adds CHECK constraints for enum properties
 * - Generates FOREIGN KEY constraints for single references
 * - Skips properties with x-computed: true
 *
 * @module ddl/table-generator
 */

import type { TableDef, ColumnDef, ForeignKeyDef, SqlDialect } from "./types"
import { mapPropertyType } from "./type-mapper"
import {
  inferPrimaryKey,
  inferNotNull,
  inferForeignKey,
  inferCheckConstraint,
} from "./constraint-builder"
import { toSnakeCase } from "./utils"
import { qualifyTableName, type QualifyDialect } from "./namespace"

/**
 * Generates a CREATE TABLE definition for an Enhanced JSON Schema model
 *
 * This function transforms an Enhanced JSON Schema model definition into a
 * structured TableDef that can be used to generate SQL DDL statements.
 *
 * The generation process:
 * 1. Identifies the primary key using inferPrimaryKey()
 * 2. Iterates over all properties
 * 3. Skips computed properties (x-computed: true)
 * 4. Maps each property to a ColumnDef using type-mapper
 * 5. Applies NOT NULL constraints using constraint-builder
 * 6. Applies CHECK constraints for enum properties
 * 7. Generates FOREIGN KEY constraints for single references
 *
 * Table naming:
 * - Uses 1:1 mapping with model name (no pluralization)
 * - Example: "Organization" model → "Organization" table
 *
 * Column naming:
 * - Converts PascalCase/camelCase to snake_case
 * - Example: "createdAt" property → "created_at" column
 *
 * Foreign key handling:
 * - PostgreSQL: FK constraints returned in foreignKeys array (for ALTER TABLE)
 * - SQLite: FK constraints returned in foreignKeys array (inline in CREATE TABLE)
 *
 * @param {any} model - Enhanced JSON Schema model definition
 * @param {string} modelName - Name of the model (used as table name)
 * @param {SqlDialect} dialect - SQL dialect for type mapping
 * @returns {TableDef} Table definition with columns and constraints
 *
 * @example
 * ```ts
 * const model = {
 *   properties: {
 *     id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
 *     name: { type: "string" },
 *     organizationId: {
 *       type: "string",
 *       "x-reference-type": "single",
 *       "x-reference-target": "Organization"
 *     }
 *   },
 *   required: ["name", "organizationId"]
 * }
 *
 * const table = generateCreateTable(model, "Team", pgDialect)
 * // => {
 * //   name: "Team",
 * //   primaryKey: "id",
 * //   columns: [
 * //     { name: "id", type: "UUID", nullable: false },
 * //     { name: "name", type: "TEXT", nullable: false },
 * //     { name: "organization_id", type: "UUID", nullable: false }
 * //   ],
 * //   foreignKeys: [
 * //     {
 * //       name: "fk_Team_organization_id",
 * //       table: "Team",
 * //       column: "organization_id",
 * //       referencesTable: "Organization",
 * //       referencesColumn: "id",
 * //       onDelete: "CASCADE"
 * //     }
 * //   ]
 * // }
 * ```
 */
export function generateCreateTable(
  model: any,
  modelName: string,
  dialect: SqlDialect,
  namespace?: string
): TableDef {
  // 1. Identify the primary key
  const primaryKeyProp = inferPrimaryKey(model)
  const primaryKeyName = primaryKeyProp.name

  // 2. Extract properties and required array
  const properties = model.properties || {}
  const required = model.required || []

  // Determine dialect name for qualifyTableName
  const dialectName: QualifyDialect = dialect.name === "sqlite" ? "sqlite" : "postgresql"

  // 3. Compute table name (with namespace if provided)
  const baseTableName = toSnakeCase(modelName)
  const tableName = namespace
    ? qualifyTableName(namespace, baseTableName, dialectName)
    : baseTableName

  // 4. Generate columns and foreign keys
  const columns: ColumnDef[] = []
  const foreignKeys: ForeignKeyDef[] = []

  for (const propName in properties) {
    const prop = properties[propName]

    // Skip computed properties (inverse relationships, derived values)
    if (prop["x-computed"] === true) {
      continue
    }

    // Handle single reference properties (foreign keys)
    if (prop["x-reference-type"] === "single") {
      const fk = inferForeignKey(
        { name: propName, ...prop },
        modelName,
        required,
        namespace,
        dialectName
      )

      if (fk) {
        // Add FK column
        const columnName = fk.column
        const sqlType = mapPropertyType(
          { type: "string", format: "uuid" },
          dialect
        )
        const nullable = !inferNotNull({ name: propName, ...prop }, required)

        columns.push({
          name: columnName,
          type: sqlType,
          nullable,
        })

        // Store FK constraint for later
        foreignKeys.push(fk)
      }

      continue
    }

    // Skip array reference properties (handled by junction-generator)
    if (prop["x-reference-type"] === "array") {
      continue
    }

    // Generate regular column
    const columnName = toSnakeCase(propName)
    const sqlType = mapPropertyType(prop, dialect)
    const nullable = !inferNotNull({ name: propName, ...prop }, required)

    // Check for enum constraint
    const checkConstraint = inferCheckConstraint({ name: columnName, ...prop })

    const column: ColumnDef = {
      name: columnName,
      type: sqlType,
      nullable,
    }

    if (checkConstraint) {
      column.checkConstraint = checkConstraint
    }

    columns.push(column)
  }

  // 5. Return TableDef structure
  return {
    name: tableName, // qualified or base table name
    columns,
    primaryKey: primaryKeyName,
    foreignKeys,
  }
}
