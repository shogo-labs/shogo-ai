/**
 * Schema Diff Detection
 *
 * Compares two Enhanced JSON Schema versions to detect changes.
 * Used to generate migration operations for schema evolution.
 *
 * @module ddl/diff
 */

import type { SchemaDiff, ModelDiff, ColumnModification } from "./migration-types"
import type { ColumnDef } from "./types"
import { toSnakeCase } from "./utils"

/**
 * Compares two Enhanced JSON Schema versions and returns detected changes.
 *
 * @param oldSchema - Previous schema version
 * @param newSchema - New schema version
 * @returns SchemaDiff describing all detected changes
 *
 * @example
 * ```ts
 * const oldSchema = { $defs: { User: { properties: { id: { type: "string" } } } } }
 * const newSchema = { $defs: {
 *   User: { properties: { id: { type: "string" }, email: { type: "string" } } },
 *   Post: { properties: { id: { type: "string" } } }
 * } }
 *
 * const diff = compareSchemas(oldSchema, newSchema)
 * // diff.addedModels => ["Post"]
 * // diff.modifiedModels[0].addedColumns => [{ name: "email", ... }]
 * ```
 */
export function compareSchemas(oldSchema: any, newSchema: any): SchemaDiff {
  const oldDefs = oldSchema.$defs || oldSchema.definitions || {}
  const newDefs = newSchema.$defs || newSchema.definitions || {}

  const oldModelNames = new Set(Object.keys(oldDefs))
  const newModelNames = new Set(Object.keys(newDefs))

  // Detect added models and store their full definitions
  const addedModels: string[] = []
  const addedModelDefs: Record<string, any> = {}
  for (const name of newModelNames) {
    if (!oldModelNames.has(name)) {
      addedModels.push(name)
      addedModelDefs[name] = newDefs[name]
    }
  }

  // Detect removed models
  const removedModels: string[] = []
  for (const name of oldModelNames) {
    if (!newModelNames.has(name)) {
      removedModels.push(name)
    }
  }

  // Detect modified models (models that exist in both schemas)
  const modifiedModels: ModelDiff[] = []
  for (const name of oldModelNames) {
    if (newModelNames.has(name)) {
      const modelDiff = compareModels(name, oldDefs[name], newDefs[name])
      if (modelDiff.addedColumns.length > 0 ||
          modelDiff.removedColumns.length > 0 ||
          modelDiff.modifiedColumns.length > 0) {
        modifiedModels.push(modelDiff)
      }
    }
  }

  const hasChanges = addedModels.length > 0 ||
                     removedModels.length > 0 ||
                     modifiedModels.length > 0

  return {
    addedModels,
    addedModelDefs,
    removedModels,
    modifiedModels,
    hasChanges,
  }
}

/**
 * Compares two model definitions and returns detected column changes.
 *
 * @param modelName - Name of the model being compared
 * @param oldModel - Previous model definition
 * @param newModel - New model definition
 * @returns ModelDiff describing column changes
 */
function compareModels(modelName: string, oldModel: any, newModel: any): ModelDiff {
  const oldProps = oldModel.properties || {}
  const newProps = newModel.properties || {}
  const oldRequired = new Set(oldModel.required || [])
  const newRequired = new Set(newModel.required || [])

  const oldPropNames = new Set(Object.keys(oldProps))
  const newPropNames = new Set(Object.keys(newProps))

  // Detect added columns
  const addedColumns: ColumnDef[] = []
  for (const name of newPropNames) {
    if (!oldPropNames.has(name)) {
      addedColumns.push(propertyToColumnDef(name, newProps[name], newRequired.has(name)))
    }
  }

  // Detect removed columns
  const removedColumns: string[] = []
  for (const name of oldPropNames) {
    if (!newPropNames.has(name)) {
      removedColumns.push(name)
    }
  }

  // Detect modified columns
  const modifiedColumns: ColumnModification[] = []
  for (const name of oldPropNames) {
    if (newPropNames.has(name)) {
      const modification = compareColumns(
        name,
        oldProps[name],
        newProps[name],
        oldRequired.has(name),
        newRequired.has(name)
      )
      if (modification) {
        modifiedColumns.push(modification)
      }
    }
  }

  return {
    modelName,
    addedColumns,
    removedColumns,
    modifiedColumns,
  }
}

/**
 * Compares two column definitions and returns detected changes.
 *
 * @param columnName - Name of the column being compared
 * @param oldProp - Previous property definition
 * @param newProp - New property definition
 * @param wasRequired - Whether the column was required in old schema
 * @param isRequired - Whether the column is required in new schema
 * @returns ColumnModification if changes detected, null otherwise
 */
function compareColumns(
  columnName: string,
  oldProp: any,
  newProp: any,
  wasRequired: boolean,
  isRequired: boolean
): ColumnModification | null {
  // Check for type change
  if (oldProp.type !== newProp.type) {
    return {
      columnName,
      oldDef: propertyToColumnDef(columnName, oldProp, wasRequired),
      newDef: propertyToColumnDef(columnName, newProp, isRequired),
      changeType: "type",
    }
  }

  // Check for nullability change (required → optional or vice versa)
  if (wasRequired !== isRequired) {
    return {
      columnName,
      oldDef: propertyToColumnDef(columnName, oldProp, wasRequired),
      newDef: propertyToColumnDef(columnName, newProp, isRequired),
      changeType: "nullability",
    }
  }

  // Check for default value change
  const oldDefault = oldProp.default
  const newDefault = newProp.default
  if (oldDefault !== newDefault) {
    // Handle both addition and removal of default
    if (oldDefault === undefined && newDefault !== undefined) {
      return {
        columnName,
        oldDef: propertyToColumnDef(columnName, oldProp, wasRequired),
        newDef: propertyToColumnDef(columnName, newProp, isRequired),
        changeType: "default",
      }
    }
    if (oldDefault !== undefined && newDefault === undefined) {
      return {
        columnName,
        oldDef: propertyToColumnDef(columnName, oldProp, wasRequired),
        newDef: propertyToColumnDef(columnName, newProp, isRequired),
        changeType: "default",
      }
    }
    // Default value itself changed
    if (JSON.stringify(oldDefault) !== JSON.stringify(newDefault)) {
      return {
        columnName,
        oldDef: propertyToColumnDef(columnName, oldProp, wasRequired),
        newDef: propertyToColumnDef(columnName, newProp, isRequired),
        changeType: "default",
      }
    }
  }

  // Check for enum change (constraint modification)
  if (hasEnumChanged(oldProp.enum, newProp.enum)) {
    return {
      columnName,
      oldDef: propertyToColumnDef(columnName, oldProp, wasRequired),
      newDef: propertyToColumnDef(columnName, newProp, isRequired),
      changeType: "constraint",
    }
  }

  // No changes detected
  return null
}

/**
 * Checks if enum values have changed between two property definitions.
 * Uses Set comparison to detect value changes while ignoring order.
 *
 * @param oldEnum - Previous enum values array
 * @param newEnum - New enum values array
 * @returns True if enum values changed, false otherwise
 */
function hasEnumChanged(oldEnum: any[] | undefined, newEnum: any[] | undefined): boolean {
  // Both undefined - no change
  if (!oldEnum && !newEnum) return false
  // One undefined, other defined - change (added or removed enum)
  if (!oldEnum || !newEnum) return true
  // Different lengths - change
  if (oldEnum.length !== newEnum.length) return true
  // Compare values using Set (order-independent)
  const oldSet = new Set(oldEnum)
  for (const value of newEnum) {
    if (!oldSet.has(value)) return true
  }
  return false
}

/**
 * Converts a JSON Schema property definition to a ColumnDef.
 *
 * @param name - Property name
 * @param prop - Property definition
 * @param isRequired - Whether the property is in the required array
 * @returns ColumnDef for the property
 */
export function propertyToColumnDef(name: string, prop: any, isRequired: boolean): ColumnDef {
  // Map JSON Schema type to SQL type (simplified)
  let sqlType = "TEXT"
  switch (prop.type) {
    case "integer":
      sqlType = "INTEGER"
      break
    case "number":
      sqlType = "REAL"
      break
    case "boolean":
      sqlType = "BOOLEAN"
      break
    case "string":
      if (prop.format === "uuid") {
        sqlType = "UUID"
      } else if (prop.format === "date-time") {
        sqlType = "TIMESTAMP"
      } else {
        sqlType = "TEXT"
      }
      break
    case "array":
    case "object":
      sqlType = "JSONB"
      break
  }

  // Convert JSON Schema default to SQL default value
  let defaultValue: string | undefined
  if (prop.default !== undefined) {
    defaultValue = jsonDefaultToSql(prop.default, prop.type)
  }

  return {
    name: toSnakeCase(name),
    type: sqlType,
    nullable: !isRequired,
    ...(defaultValue !== undefined && { defaultValue }),
    // Capture enum values for constraint generation
    ...(prop.enum && Array.isArray(prop.enum) && { enumValues: prop.enum }),
  }
}

/**
 * Converts a JSON Schema default value to a SQL-escaped default value string.
 *
 * @param value - The JSON default value
 * @param jsonType - The JSON Schema type of the property
 * @returns SQL-escaped default value string
 */
export function jsonDefaultToSql(value: any, jsonType?: string): string {
  if (value === null) {
    return "NULL"
  }

  switch (jsonType) {
    case "string":
      // Escape single quotes and wrap in quotes
      return `'${String(value).replace(/'/g, "''")}'`
    case "integer":
    case "number":
      return String(value)
    case "boolean":
      // SQLite uses 0/1 for boolean
      return value ? "1" : "0"
    default:
      // For unknown types, try to infer from value type
      if (typeof value === "string") {
        return `'${value.replace(/'/g, "''")}'`
      }
      if (typeof value === "number") {
        return String(value)
      }
      if (typeof value === "boolean") {
        return value ? "1" : "0"
      }
      // For objects/arrays, use JSON
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`
  }
}
