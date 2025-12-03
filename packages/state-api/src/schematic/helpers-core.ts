/**
 * Core helper functions for arktype-to-json-schema conversion (Phase 2)
 * Original enhancement functions - extracted to work around esbuild WASM file size limits
 */

import type { EnhancedJsonSchema } from './types';

/**
 * Helper to check if a schema matches an arkType alias structure
 * (Internal helper - not exported)
 */
function structureMatches(schema: any, arkAlias: any): boolean {
  if (!schema.properties || typeof arkAlias !== "object") return false;

  const schemaKeys = Object.keys(schema.properties).sort();
  const aliasKeys = Object.keys(arkAlias)
    .map(key => key.replace(/\?$/, ""))
    .sort();

  return schemaKeys.every(key => aliasKeys.includes(key));
}

/**
 * Process a single entry to find matching type name
 * (Extracted to avoid nested loops in Object.entries - esbuild WASM bug)
 */
function findMatchingType(
  defSchema: any,
  typeNames: string[],
  scopeAliases: Record<string, any>
): string | null {
  if (defSchema.type !== "object" || !defSchema.properties) return null;

  for (const typeName of typeNames) {
    const typeAlias = scopeAliases[typeName];
    if (typeAlias && structureMatches(defSchema, typeAlias)) {
      return typeName;
    }
  }

  return null;
}

/**
 * Creates a mapping between arkType's generated names and our meaningful names
 */
export function createNameMapping(
  schema: EnhancedJsonSchema,
  typeNames: string[],
  scopeAliases: Record<string, any>
): Record<string, string> {
  const mapping: Record<string, string> = {};

  if (!schema.$defs) return mapping;

  for (const entry of Object.entries(schema.$defs)) {
    const defName = entry[0];
    const defSchema = entry[1];

    const matchedType = findMatchingType(defSchema, typeNames, scopeAliases);
    if (matchedType) {
      mapping[defName] = matchedType;
    }
  }

  return mapping;
}

/**
 * Enhances an array definition with metadata
 */
export function enhanceArrayDefinition(
  def: any,
  typeName: string,
  scopeAliases: Record<string, any>,
  options: any
): void {
  if (def.items?.$ref) {
    def["x-reference-type"] = "array";
  }
}

/**
 * Enhances nested schemas recursively
 */
export function enhanceNestedSchemas(
  schema: any,
  scopeAliases: Record<string, any>,
  options: any
): void {
  if (schema.properties) {
    for (const propSchema of Object.values(schema.properties)) {
      enhanceNestedSchemas(propSchema, scopeAliases, options);
    }
  }

  if (schema.items) {
    enhanceNestedSchemas(schema.items, scopeAliases, options);
  }

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (schema[key] && Array.isArray(schema[key])) {
      for (const subSchema of schema[key]) {
        enhanceNestedSchemas(subSchema, scopeAliases, options);
      }
    }
  }
}

/**
 * Enhances an object definition with x-metadata
 */
export function enhanceObjectDefinition(
  def: any,
  typeName: string,
  arkAlias: any,
  scopeAliases: Record<string, any>,
  options: any
): void {
  if (!def.properties) return;

  if (!arkAlias) {
    for (const entry of Object.entries(def.properties)) {
      const propName = entry[0];
      const propSchema = entry[1];
      const prop = propSchema as any;

      if (prop["x-arktype"]) continue;

      if (prop.$ref) {
        const refName = prop.$ref.replace("#/$defs/", "");
        if (refName && prop["x-reference-type"]) {
          prop["x-arktype"] = prop["x-reference-type"] === "array" ? `${refName}[]` : refName;
        }
      }
      else if (prop.anyOf && prop.format === "uuid") {
        prop["x-arktype"] = "string.uuid";
      }
      else if (prop.type === "string") {
        prop["x-arktype"] = "string";
      }
      else if (prop.type === "number") {
        prop["x-arktype"] = "number";
      }
    }
    return;
  }

  for (const entry of Object.entries(def.properties)) {
    const propName = entry[0];
    const propSchema = entry[1];
    const prop = propSchema as any;
    const arkPropDef = arkAlias[propName];

    if (arkPropDef) {
      prop["x-arktype"] = arkPropDef;

      if (typeof arkPropDef === "string") {
        if (scopeAliases[arkPropDef]) {
          prop["x-reference-type"] = "single";
        }
        else if (arkPropDef.endsWith("[]")) {
          const entityName = arkPropDef.slice(0, -2);
          if (scopeAliases[entityName]) {
            prop["x-reference-type"] = "array";
          }
        }
      }
    }
  }
}

/**
 * Updates $ref paths to use new definition names
 * (Internal helper - not exported)
 */
function updateRefPaths(
  schema: any,
  nameMapping: Record<string, string>
): void {
  if (typeof schema !== "object" || schema === null) return;

  if (schema.$ref && typeof schema.$ref === "string") {
    const match = schema.$ref.match(/#\/\$defs\/(.+)/);
    if (match) {
      const oldName = match[1];
      const newName = nameMapping[oldName] || oldName;
      schema.$ref = `#/$defs/${newName}`;
    }
  }

  for (const key of Object.keys(schema)) {
    if (key === "$ref") continue;

    const value = schema[key];
    if (Array.isArray(value)) {
      value.forEach((item) => updateRefPaths(item, nameMapping));
    } else if (typeof value === "object" && value !== null) {
      updateRefPaths(value, nameMapping);
    }
  }
}

/**
 * Remaps definition names and $ref paths to use meaningful names
 */
export function remapDefinitionNames(
  schema: EnhancedJsonSchema,
  nameMapping: Record<string, string>
): void {
  if (!schema.$defs) return;

  const newDefs: Record<string, any> = {};
  const arrayDefsToRemove = new Set<string>();

  for (const entry of Object.entries(schema.$defs)) {
    const oldName = entry[0];
    const def = entry[1];
    const d = def as any;
    if (d.type === "array" && d.items?.$ref && !nameMapping[oldName]) {
      arrayDefsToRemove.add(oldName);
    }
  }

  for (const entry of Object.entries(schema.$defs)) {
    const oldName = entry[0];
    const def = entry[1];
    if (!arrayDefsToRemove.has(oldName)) {
      const newName = nameMapping[oldName] || oldName;
      newDefs[newName] = def;
    }
  }

  schema.$defs = newDefs;
  updateRefPaths(schema, nameMapping);
}
