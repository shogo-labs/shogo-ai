/**
 * DDL constraint builder
 *
 * This module provides functions to infer database constraints (PRIMARY KEY,
 * FOREIGN KEY, NOT NULL, CHECK) from Enhanced JSON Schema metadata.
 *
 * Constraints are derived from x-* extensions in the schema:
 * - x-mst-type: "identifier" → PRIMARY KEY
 * - x-reference-type: "single" → FOREIGN KEY
 * - required array → NOT NULL
 * - enum values → CHECK constraint
 *
 * @module ddl/constraint-builder
 */

import type { ForeignKeyDef } from "./types"
import { toSnakeCase } from "./utils"

/**
 * Infers the primary key property from an Enhanced JSON Schema model
 *
 * Searches for a property with x-mst-type: "identifier" and returns it.
 * The identifier property is always considered NOT NULL regardless of
 * the required array.
 *
 * @param {any} model - Enhanced JSON Schema model definition
 * @returns {any} The property object that serves as the primary key
 * @throws {Error} If no identifier found or multiple identifiers exist
 *
 * @example
 * ```ts
 * const model = {
 *   properties: {
 *     id: { type: "string", "x-mst-type": "identifier" },
 *     name: { type: "string" }
 *   }
 * }
 * const pk = inferPrimaryKey(model)
 * // => { name: "id", type: "string", "x-mst-type": "identifier" }
 * ```
 */
export function inferPrimaryKey(model: any): any {
  const properties = model.properties || {}
  const identifiers: Array<{ name: string; property: any }> = []

  // Find all properties with x-mst-type: "identifier"
  for (const propName in properties) {
    const prop = properties[propName]
    if (prop["x-mst-type"] === "identifier") {
      identifiers.push({ name: propName, property: prop })
    }
  }

  // Validate exactly one identifier
  if (identifiers.length === 0) {
    throw new Error(
      "No identifier property found. Each model must have exactly one property with x-mst-type: 'identifier'"
    )
  }

  if (identifiers.length > 1) {
    const names = identifiers.map((id) => id.name).join(", ")
    throw new Error(
      `Multiple identifier properties found: ${names}. Each model must have exactly one identifier`
    )
  }

  // Return the identifier with its name attached
  return {
    name: identifiers[0].name,
    ...identifiers[0].property,
  }
}

/**
 * Determines if a property should have a NOT NULL constraint
 *
 * A property is NOT NULL if:
 * 1. It has x-mst-type: "identifier" (primary keys are always NOT NULL), OR
 * 2. It appears in the model's required array
 *
 * @param {any} property - Property definition with name attached
 * @param {string[]} required - Array of required property names from model
 * @returns {boolean} True if property should be NOT NULL
 *
 * @example
 * ```ts
 * const prop = { name: "email", type: "string" }
 * const required = ["email", "name"]
 * inferNotNull(prop, required) // => true
 *
 * const optionalProp = { name: "description", type: "string" }
 * inferNotNull(optionalProp, required) // => false
 *
 * const idProp = { name: "id", type: "string", "x-mst-type": "identifier" }
 * inferNotNull(idProp, []) // => true (identifier always NOT NULL)
 * ```
 */
export function inferNotNull(property: any, required: string[]): boolean {
  // Identifiers are always NOT NULL regardless of required array
  if (property["x-mst-type"] === "identifier") {
    return true
  }

  // Check if property name is in required array
  const propName = property.name
  return required.includes(propName)
}

/**
 * Infers a FOREIGN KEY constraint from a reference property
 *
 * Returns a ForeignKeyDef if the property has:
 * - x-reference-type: "single" (one-to-one or many-to-one relationship)
 * - x-reference-target: specifies the target model
 *
 * Properties are skipped if:
 * - x-computed: true (computed/inverse relationships are not stored)
 * - x-reference-type: "array" (many-to-many uses junction tables)
 *
 * Column name follows the pattern: snake_case(target) + "_id"
 * Constraint name follows: "fk_{table}_{column}"
 *
 * ON DELETE behavior:
 * - CASCADE: If property is in required array (required reference)
 * - SET NULL: If property is optional (not in required array)
 *
 * @param {any} property - Property definition with name attached
 * @param {string} modelName - Name of the model containing this property
 * @param {string[]} required - Array of required property names
 * @returns {ForeignKeyDef | null} Foreign key definition or null if not a FK
 *
 * @example
 * ```ts
 * const prop = {
 *   name: "organizationId",
 *   "x-reference-type": "single",
 *   "x-reference-target": "Organization"
 * }
 * const fk = inferForeignKey(prop, "Team", ["organizationId"])
 * // => {
 * //   name: "fk_Team_organization_id",
 * //   table: "Team",
 * //   column: "organization_id",
 * //   referencesTable: "Organization",
 * //   referencesColumn: "id",
 * //   onDelete: "CASCADE"
 * // }
 * ```
 */
export function inferForeignKey(
  property: any,
  modelName: string,
  required: string[]
): ForeignKeyDef | null {
  // Skip computed properties (inverse relationships)
  if (property["x-computed"] === true) {
    return null
  }

  // Only process single references (one-to-one or many-to-one)
  if (property["x-reference-type"] !== "single") {
    return null
  }

  // Derive target from x-reference-target, x-arktype, or $ref
  let target = property["x-reference-target"]
  if (!target && property["x-arktype"]) {
    // x-arktype contains the type name directly (e.g., "Organization")
    target = property["x-arktype"]
  }
  if (!target && property["$ref"]) {
    // Extract from $ref (e.g., "#/$defs/Organization" -> "Organization")
    const refMatch = property["$ref"].match(/#\/\$defs\/(.+)/)
    if (refMatch) {
      target = refMatch[1]
    }
  }
  if (!target) {
    return null
  }

  // Derive column name from target type: Organization -> organization_id
  // This ensures consistent FK column naming regardless of property name
  const columnName = toSnakeCase(target) + "_id"

  // Use snake_case for table names (matches DDL generator and query executor)
  const tableName = toSnakeCase(modelName)
  const referencesTableName = toSnakeCase(target)

  // Derive constraint name: fk_{table}_{column}
  const constraintName = `fk_${tableName}_${columnName}`

  // Determine ON DELETE behavior
  const isRequired = required.includes(property.name)
  const onDelete = isRequired ? "CASCADE" : "SET NULL"

  return {
    name: constraintName,
    table: tableName,
    column: columnName,
    referencesTable: referencesTableName,
    referencesColumn: "id",
    onDelete,
  }
}

/**
 * Infers a CHECK constraint clause for enum properties
 *
 * Returns a CHECK constraint SQL clause for properties with an enum array.
 * The constraint ensures the column value is one of the allowed enum values.
 *
 * Format: "{columnName} IN ('value1', 'value2', 'value3')"
 *
 * Properties with x-computed: true are skipped (computed fields not stored).
 *
 * @param {any} property - Property definition with name attached
 * @returns {string | null} CHECK constraint SQL clause or null if not enum
 *
 * @example
 * ```ts
 * const prop = {
 *   name: "status",
 *   type: "string",
 *   enum: ["active", "inactive", "pending"]
 * }
 * const check = inferCheckConstraint(prop)
 * // => "status IN ('active', 'inactive', 'pending')"
 * ```
 */
export function inferCheckConstraint(property: any): string | null {
  // Skip computed properties
  if (property["x-computed"] === true) {
    return null
  }

  // Only process properties with enum
  if (!property.enum || !Array.isArray(property.enum)) {
    return null
  }

  const columnName = property.name
  const enumValues = property.enum
    .map((value: any) => `'${value}'`)
    .join(", ")

  return `${columnName} IN (${enumValues})`
}
