/**
 * Foundation helper functions for schema processing
 * Base utilities with no dependencies on other helper files
 */

import type { EnhancedJsonSchema } from './types';

/**
 * Checks if two schemas are structurally equivalent
 */
export function schemasMatch(schema1: any, schema2: any): boolean {
  // Both must be objects
  if (schema1.type !== "object" || schema2.type !== "object") return false;
  if (!schema1.properties || !schema2.properties) return false;

  const keys1 = Object.keys(schema1.properties).sort();
  const keys2 = Object.keys(schema2.properties).sort();

  // Must have same property keys
  if (keys1.length !== keys2.length || !keys1.every((key, i) => key === keys2[i])) {
    return false;
  }

  // Check if required arrays match (ignoring order)
  const req1 = new Set(schema1.required || []);
  const req2 = new Set(schema2.required || []);
  if (req1.size !== req2.size || !Array.from(req1).every(r => req2.has(r))) {
    return false;
  }

  // Basic structural match
  return true;
}

/**
 * Checks if a schema matches an exported type by comparing structure
 */
export function structureMatchesType(schema: any, exportedType: any): boolean {
  try {
    // Get the JSON Schema of the exported type
    const typeSchema = exportedType.toJsonSchema();

    // Compare the properties
    if (!schema.properties || !typeSchema.properties) return false;

    const schemaProps = Object.keys(schema.properties).sort();
    const typeProps = Object.keys(typeSchema.properties).sort();

    // Must have same properties
    return (
      schemaProps.length === typeProps.length &&
      schemaProps.every((key, i) => key === typeProps[i])
    );
  } catch {
    return false;
  }
}

/**
 * Normalizes property schemas (e.g., anyOf for UUIDs)
 */
export function normalizePropertySchema(schema: any, propName: string): any {
  // Normalize UUID anyOf structure
  if (schema.anyOf && schema.format === "uuid") {
    const normalized: any = {
      type: "string",
      format: "uuid",
    };

    // Preserve other properties
    if (schema.description) normalized.description = schema.description;

    // Mark as identifier if it's named 'id' or ends with 'Id'
    if (propName === "id" || propName.endsWith("Id")) {
      normalized["x-mst-type"] = "identifier";
    }

    return normalized;
  }

  // Normalize enum order for consistency
  if (schema.enum && Array.isArray(schema.enum)) {
    return {
      ...schema,
      enum: [...schema.enum].sort(),
    };
  }

  // Normalize prefixItems to items for arrays
  if (schema.type === "array" && schema.prefixItems && !schema.items) {
    // Convert tuple-like array to regular array with items
    const normalized: any = {
      type: "array",
      items: schema.prefixItems[0], // Use the first item as the schema for all items
    };

    // Preserve other properties except prefixItems
    for (const key in schema) {
      if (key !== "prefixItems" && key !== "items" && key !== "minItems") {
        normalized[key] = schema[key];
      }
    }

    return normalized;
  }

  // Return as-is if no normalization needed
  return schema;
}

/**
 * Infers arkType definition string from JSON Schema
 */
export function inferArkTypeFromSchema(schema: any, propName: string): string | null {
  // Handle anyOf for UUID types
  if (schema.anyOf && schema.format === "uuid") {
    return "string.uuid";
  }

  // Handle strings
  if (schema.type === "string") {
    if (schema.format === "uuid") return "string.uuid";
    if (schema.format === "email") return "string.email";
    if (schema.minLength !== undefined) return `string >= ${schema.minLength}`;
    return "string";
  }

  // Handle numbers
  if (schema.type === "number") {
    if (schema.minimum !== undefined) return `number >= ${schema.minimum}`;
    if (schema.maximum !== undefined) return `number <= ${schema.maximum}`;
    return "number";
  }

  // Handle arrays
  if (schema.type === "array" && schema.items) {
    const itemType = inferArkTypeFromSchema(schema.items, "");
    return itemType ? `${itemType}[]` : null;
  }

  // Handle enums
  if (schema.enum) {
    // Sort enum values for consistent output
    const sorted = [...schema.enum].sort();
    return sorted.map((v: any) => `'${v}'`).join(" | ");
  }

  return null;
}
