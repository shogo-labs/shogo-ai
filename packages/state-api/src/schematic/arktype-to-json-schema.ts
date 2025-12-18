/**
 * Enhanced ArkType to JSON Schema converter - MINIMAL STUB for binary search
 */

import { type Type, type Scope } from "arktype";
import type { EnhancedJsonSchema, EnhancedJsonSchemaOptions } from "./types";
import {
  schemasMatch,
  structureMatchesType,
  normalizePropertySchema,
  inferArkTypeFromSchema
} from "./helpers-foundation";
import {
  createNameMapping,
  enhanceObjectDefinition,
  enhanceArrayDefinition,
  enhanceNestedSchemas,
  remapDefinitionNames
} from "./helpers-core";
import {
  enhanceSingleTypeFromSchema,
  detectAndReplaceEntityReferences,
  enhanceDefinitions
} from "./helpers-advanced";
import {
  enhancePropertiesForMultiDomain,
  detectComputedArraysMultiDomain
} from "./helpers-multidomain";

// ============================================
// Helper functions (defined BEFORE use)
// ============================================

/**
 * Resolves nested $refs within a schema definition
 */
function resolveNestedRefs(schema: any, defs: Record<string, any>): any {
  if (!schema || typeof schema !== "object") return schema;

  // Clone to avoid mutations
  const resolved = JSON.parse(JSON.stringify(schema));

  // Recursively resolve refs in properties
  if (resolved.properties) {
    for (const [propName, propSchema] of Object.entries(resolved.properties)) {
      const prop = propSchema as any;

      // If property has a $ref to an internal definition
      if (prop.$ref && prop.$ref.startsWith("#/$defs/")) {
        const refName = prop.$ref.replace("#/$defs/", "");
        if (defs[refName] && (refName.startsWith("intersection") || refName.startsWith("union"))) {
          // Replace with the resolved definition for simple types
          const refDef = defs[refName];

          // For simple types (string, number, arrays of primitives), inline the definition
          if (refDef.type === "string" || refDef.type === "number" ||
            (refDef.type === "array" && refDef.items?.type)) {
            resolved.properties[propName] = JSON.parse(JSON.stringify(refDef));
          } else if (refDef.anyOf) {
            // For unions (like UUID), keep as-is but ensure it's resolved
            resolved.properties[propName] = JSON.parse(JSON.stringify(refDef));
          }
        }
      }
      // Recursively resolve nested objects
      else if (prop.type === "object" && prop.properties) {
        resolved.properties[propName] = resolveNestedRefs(prop, defs);
      }
    }
  }

  return resolved;
}

/**
 * Checks if a JSON Schema definition matches an arkType alias structure
 */
function structureMatches(schema: any, arkAlias: any): boolean {
  if (!schema.properties || typeof arkAlias !== "object") return false;

  const schemaKeys = Object.keys(schema.properties).sort();
  // Remove optional markers from alias keys for comparison
  const aliasKeys = Object.keys(arkAlias)
    .map(key => key.replace(/\?$/, ""))
    .sort();

  // Check if all schema keys exist in alias keys (allowing for optional properties)
  return schemaKeys.every(key => aliasKeys.includes(key));
}

/**
 * Updates $ref paths to use new definition names
 */
function updateRefPaths(
  schema: any,
  nameMapping: Record<string, string>
): void {
  if (typeof schema !== "object" || schema === null) return;

  // Update $ref if present
  if (schema.$ref && typeof schema.$ref === "string") {
    const match = schema.$ref.match(/#\/\$defs\/(.+)/);
    if (match) {
      const oldName = match[1];
      const newName = nameMapping[oldName] || oldName;
      schema.$ref = `#/$defs/${newName}`;
    }
  }

  // Recursively update nested schemas
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
 * Detects computed arrays based on inverse relationships
 */
function detectComputedArrays(defs: Record<string, any>): void {
  // Analyze relationships to detect computed arrays
  for (const [typeName, schema] of Object.entries(defs)) {
    if (!schema.properties) continue;

    for (const [propName, propDef] of Object.entries(schema.properties)) {
      const prop = propDef as any;

      // Check if this is an array reference
      if (
        prop["x-reference-type"] === "array" ||
        (prop.type === "array" && prop.items?.$ref)
      ) {
        const targetEntity =
          prop.items?.$ref?.replace("#/$defs/", "") ||
          prop.$ref?.replace("#/$defs/", "");

        if (!targetEntity) continue;

        // Look for inverse single reference
        const targetSchema = defs[targetEntity];
        if (targetSchema?.properties) {
          for (const [targetProp, targetPropDef] of Object.entries(
            targetSchema.properties
          )) {
            const targetRef = targetPropDef as any;

            // Found inverse reference
            if (
              (targetRef.$ref === `#/$defs/${typeName}` ||
                targetRef["x-reference-type"] === "single") &&
              targetRef["x-arktype"] === typeName
            ) {
              // Mark as computed
              prop["x-computed"] = true;
              prop["x-inverse"] = targetProp;
              break;
            }
          }
        }
      }
    }
  }

  // Second pass: Remove computed properties from required arrays
  for (const [typeName, schema] of Object.entries(defs)) {
    if (!schema.required || !schema.properties) continue;

    // Filter out computed properties from required array
    const computedProps = new Set<string>();
    for (const [propName, propDef] of Object.entries(schema.properties)) {
      if ((propDef as any)["x-computed"]) {
        computedProps.add(propName);
      }
    }

    if (computedProps.size > 0) {
      schema.required = schema.required.filter((prop: string) => !computedProps.has(prop));
    }
  }
}

function isScope(value: any): value is Scope<any> {
  return value && typeof value === "object" && typeof value.export === "function";
}

function isMultiDomainInput(value: any): value is Record<string, Scope<any>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (typeof value.export === "function") {
    return false;
  }
  const values = Object.values(value);
  return values.length > 0 && values.every(v => isScope(v));
}

function convertMultiDomainsToEnhancedJsonSchema(
  domains: Record<string, Scope<any>>,
  options: EnhancedJsonSchemaOptions
): EnhancedJsonSchema {
  const schema: EnhancedJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: {}
  };

  // Process each domain
  for (const [domainName, domainScope] of Object.entries(domains)) {
    const exported = domainScope.export();
    const scopeAliases = (domainScope as any).aliases || {};

    // Convert each type in the domain
    for (const [typeName, typeExport] of Object.entries(exported)) {
      if (typeExport && typeof typeExport.toJsonSchema === "function") {
        // Get the JSON Schema for this type
        let typeSchema = typeExport.toJsonSchema() as any;
        delete typeSchema.$schema;

        // Handle complex schemas with root $ref pattern
        if (typeSchema.$ref && typeSchema.$defs) {
          const refName = typeSchema.$ref.replace("#/$defs/", "");
          if (typeSchema.$defs[refName]) {
            typeSchema = resolveNestedRefs(typeSchema.$defs[refName], typeSchema.$defs);
          }
        }

        // Clone and enhance the definition
        const def = JSON.parse(JSON.stringify(typeSchema));
        def["x-original-name"] = typeName;
        def["x-domain"] = domainName;

        // Process properties to handle references
        if (def.properties) {
          enhancePropertiesForMultiDomain(def.properties, typeName, domainName, domains, scopeAliases);
        }

        // Add to schema with namespaced key
        schema.$defs![`${domainName}.${typeName}`] = def;
      }
    }
  }

  // Second pass: Detect computed arrays if requested
  if (options.detectComputedArrays && schema.$defs) {
    detectComputedArraysMultiDomain(schema.$defs);
  }

  return schema;
}

function convertScopeToEnhancedJsonSchema(
  scope: Scope<any>,
  options: EnhancedJsonSchemaOptions
): EnhancedJsonSchema {
  const exported = scope.export();
  const scopeAliases = (scope as any).aliases || {};
  const typeNames = Object.keys(exported);

  // Start with basic schema structure
  const schema: EnhancedJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: {}
  };

  // First, collect all type schemas
  const typeSchemas: Record<string, any> = {};
  for (const typeName of typeNames) {
    const typeExport = exported[typeName];
    if (typeExport) {
      let typeSchema = typeExport.toJsonSchema() as any;
      delete typeSchema.$schema;

      // Handle complex schemas that use root $ref pattern
      if (typeSchema.$ref && typeSchema.$defs) {
        const refName = typeSchema.$ref.replace("#/$defs/", "");
        if (typeSchema.$defs[refName]) {
          typeSchema = resolveNestedRefs(typeSchema.$defs[refName], typeSchema.$defs);
        }
      }

      typeSchemas[typeName] = typeSchema;
    }
  }

  // Build $defs from the type schemas, replacing inline references
  for (const [typeName, typeSchema] of Object.entries(typeSchemas)) {
    const def = JSON.parse(JSON.stringify(typeSchema)); // Clone
    def["x-original-name"] = typeName;

    // Replace inline object references with $refs
    if (def.properties) {
      for (const [propName, propSchema] of Object.entries(def.properties)) {
        const prop = propSchema as any;

        // Get the arkType definition for this property
        const typeAlias = scopeAliases[typeName];
        const arkPropDef = typeAlias?.[propName] || typeAlias?.[`${propName}?`];

        // Check if this is an entity reference based on arkType definition
        if (arkPropDef && typeof arkPropDef === "string") {
          // Single entity reference
          if (scopeAliases[arkPropDef]) {
            def.properties[propName] = {
              $ref: `#/$defs/${arkPropDef}`,
              "x-reference-type": "single",
              "x-reference-target": arkPropDef,
              "x-arktype": arkPropDef
            };
            continue; // Skip to next property
          }
          // Array entity reference
          else if (arkPropDef.endsWith("[]")) {
            const entityName = arkPropDef.slice(0, -2);
            if (scopeAliases[entityName]) {
              def.properties[propName] = {
                type: "array",
                items: {
                  $ref: `#/$defs/${entityName}`
                },
                "x-reference-type": "array",
                "x-reference-target": entityName,
                "x-arktype": arkPropDef
              };
              continue; // Skip to next property
            }
          }
        }

        // Fallback: Check for inline object that matches another type
        if (prop.type === "object" && prop.properties) {
          for (const [otherTypeName, otherTypeSchema] of Object.entries(typeSchemas)) {
            if (typeName !== otherTypeName && schemasMatch(prop, otherTypeSchema)) {
              def.properties[propName] = {
                $ref: `#/$defs/${otherTypeName}`,
                "x-reference-type": "single",
                "x-reference-target": otherTypeName,
                "x-arktype": otherTypeName
              };
              break;
            }
          }
        }
        // Fallback: Check for array of inlined objects
        else if (prop.type === "array" && prop.items?.type === "object" && prop.items.properties) {
          for (const [otherTypeName, otherTypeSchema] of Object.entries(typeSchemas)) {
            if (schemasMatch(prop.items, otherTypeSchema)) {
              def.properties[propName] = {
                type: "array",
                items: {
                  $ref: `#/$defs/${otherTypeName}`
                },
                "x-reference-type": "array",
                "x-reference-target": otherTypeName,
                "x-arktype": `${otherTypeName}[]`
              };
              break;
            }
          }
        }
      }
    }

    schema.$defs![typeName] = def;
  }

  // Now enhance all definitions with arkType metadata
  for (const [typeName, def] of Object.entries(schema.$defs!)) {
    const typeAlias = scopeAliases[typeName];
    if (typeAlias && def.properties) {
      enhanceObjectDefinition(def, typeName, typeAlias, scopeAliases, options);
    }
  }

  // Detect computed arrays if requested
  if (options.detectComputedArrays && schema.$defs) {
    detectComputedArrays(schema.$defs);
  }

  return schema;
}

function convertTypeToEnhancedJsonSchema(
  arkType: Type,
  name?: string,
  options: EnhancedJsonSchemaOptions = { detectComputedArrays: true }
): EnhancedJsonSchema {
  try {
    // Get the base JSON Schema from arkType
    const baseSchema = arkType.toJsonSchema() as any;

    // Clone to avoid mutations
    const schema: EnhancedJsonSchema = JSON.parse(JSON.stringify(baseSchema));

    // Handle types that come from a scope
    if (options.scope && name) {
      const scopeAliases =
        options.scopeAliases || (options.scope as any).aliases || {};
      const exported = options.scope.export();

      // If this has $defs, process them
      if (schema.$defs) {
        const typeNames = Object.keys(exported);

        // Create name mapping
        const nameMapping = createNameMapping(schema, typeNames, scopeAliases);

        // Enhance definitions
        enhanceDefinitions(schema.$defs, nameMapping, scopeAliases, options);

        // Remap to use meaningful names
        remapDefinitionNames(schema, nameMapping);

        // Extract just the definition for this type
        if (schema.$defs && schema.$defs[name]) {
          return schema.$defs[name];
        }
      }

      // For types without $defs, we need to detect and replace entity references
      if (schema.type === "object" && schema.properties) {
        detectAndReplaceEntityReferences(schema, exported, scopeAliases);
      }
    }

    // For single types without a scope, we need to infer the arktype definitions
    if (schema.type === "object" && schema.properties) {
      enhanceSingleTypeFromSchema(schema, arkType);
    }

    return schema;
  } catch (error) {
    console.warn(`Failed to convert type ${name}:`, error);
    return { type: "object" };
  }
}

// ============================================
// Main exported function (uses helpers above)
// ============================================

/**
 * Converts an arkType or scope to enhanced JSON Schema
 */
export function arkTypeToEnhancedJsonSchema(
  arkType: Type | Scope<any> | Record<string, Scope<any>>,
  nameOrOptions?: string | EnhancedJsonSchemaOptions,
  options?: EnhancedJsonSchemaOptions
): EnhancedJsonSchema {
  // Handle overloaded parameters
  let name: string | undefined;
  let opts: EnhancedJsonSchemaOptions = { detectComputedArrays: true };

  if (typeof nameOrOptions === "string") {
    name = nameOrOptions;
    opts = { detectComputedArrays: true, ...options };
  } else if (nameOrOptions) {
    opts = { detectComputedArrays: true, ...nameOrOptions };
  }

  // Check if it's a multi-domain input (Record<string, Scope>)
  if (isMultiDomainInput(arkType)) {
    return convertMultiDomainsToEnhancedJsonSchema(arkType as Record<string, Scope<any>>, opts);
  }

  // Check if it's a Scope
  if (isScope(arkType)) {
    return convertScopeToEnhancedJsonSchema(arkType as Scope<any>, opts);
  }

  // It's a single Type
  return convertTypeToEnhancedJsonSchema(arkType as Type, name, opts);
}
