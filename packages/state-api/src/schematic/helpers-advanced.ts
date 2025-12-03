/**
 * Advanced helper functions for arktype-to-json-schema conversion (Phase 3)
 * Complex processing functions for single-type and entity reference handling
 */

import type { Type } from 'arktype';
import type { EnhancedJsonSchema } from './types';
import {
  normalizePropertySchema,
  inferArkTypeFromSchema,
  structureMatchesType
} from './helpers-foundation';
import {
  enhanceObjectDefinition,
  enhanceArrayDefinition,
  enhanceNestedSchemas
} from './helpers-core';

/**
 * Enhances a single type's schema when no scope is available
 */
export function enhanceSingleTypeFromSchema(
  schema: EnhancedJsonSchema,
  arkType: Type
): void {
  if (!schema.properties) return;

  // Get the arkType JSON representation to help with inference
  const arkJson = (arkType as any).json;

  for (const [propName, propSchema] of Object.entries(schema.properties)) {
    const prop = propSchema as any;

    // Normalize complex structures first
    const normalized = normalizePropertySchema(prop, propName);
    schema.properties![propName] = normalized;

    // Infer x-arktype from JSON Schema structure
    const arkTypeDef = inferArkTypeFromSchema(normalized, propName);
    if (arkTypeDef) {
      normalized["x-arktype"] = arkTypeDef;
    }
  }
}

/**
 * Detects and replaces entity references with $ref
 */
export function detectAndReplaceEntityReferences(
  schema: EnhancedJsonSchema,
  exported: Record<string, any>,
  scopeAliases: Record<string, any>
): void {
  if (!schema.properties) return;

  // Find which type this schema represents
  const schemaTypeName = schema["x-original-name"];
  const typeAlias = schemaTypeName ? scopeAliases[schemaTypeName] : null;

  for (const [propName, propSchema] of Object.entries(schema.properties)) {
    const prop = propSchema as any;

    // Check if this property in the type alias is a reference
    const propDef = typeAlias ? typeAlias[propName] || typeAlias[`${propName}?`] : null;

    if (propDef && typeof propDef === "string") {

      // Check if this is a reference to another type
      for (const [typeName, _] of Object.entries(scopeAliases)) {
        if (propDef === typeName) {
          // Single reference
          schema.properties![propName] = {
            $ref: `#/$defs/${typeName}`,
            "x-reference-type": "single",
            "x-arktype": typeName,
          };
          break;
        } else if (propDef === `${typeName}[]`) {
          // Array reference
          schema.properties![propName] = {
            type: "array",
            items: {
              $ref: `#/$defs/${typeName}`,
            },
            "x-reference-type": "array",
            "x-arktype": `${typeName}[]`,
          };
          break;
        }
      }
    }
    // Check if this property is an entity reference by structure
    else if (prop.type === "object" && prop.properties) {
      // Check if it matches any exported type
      for (const [typeName, exportedType] of Object.entries(exported)) {
        if (structureMatchesType(prop, exportedType)) {
          // Replace with $ref
          schema.properties![propName] = {
            $ref: `#/$defs/${typeName}`,
            "x-reference-type": "single",
            "x-arktype": typeName,
          };
          break;
        }
      }
    }
    // Check for array of entities
    else if (
      prop.type === "array" &&
      prop.items?.type === "object" &&
      prop.items.properties
    ) {
      for (const [typeName, exportedType] of Object.entries(exported)) {
        if (structureMatchesType(prop.items, exportedType)) {
          // Replace with array $ref
          schema.properties![propName] = {
            type: "array",
            items: {
              $ref: `#/$defs/${typeName}`,
            },
            "x-reference-type": "array",
            "x-arktype": `${typeName}[]`,
          };
          break;
        }
      }
    }
  }
}

/**
 * Enhances all definitions in a schema with x-metadata
 */
export function enhanceDefinitions(
  defs: Record<string, any>,
  nameMapping: Record<string, string>,
  scopeAliases: Record<string, any>,
  options: any
): void {
  // First pass: enhance all definitions
  for (const [defName, defSchema] of Object.entries(defs)) {
    const def = defSchema as any;
    const typeName = nameMapping[defName];

    if (typeName) {
      // Add original name metadata
      def["x-original-name"] = typeName;

      // Enhance based on type
      if (def.type === "object" && def.properties) {
        enhanceObjectDefinition(def, typeName, scopeAliases[typeName], scopeAliases, options);
      } else if (def.type === "array") {
        enhanceArrayDefinition(def, typeName, scopeAliases, options);
      }
    }

    // Enhance nested schemas
    enhanceNestedSchemas(def, scopeAliases, options);
  }

  // Second pass: replace references to array definitions with inline array structures
  for (const [defName, defSchema] of Object.entries(defs)) {
    const def = defSchema as any;

    if (def.type === "object" && def.properties) {
      for (const [propName, propSchema] of Object.entries(def.properties)) {
        const prop = propSchema as any;

        // If this references an array definition that just wraps an entity
        if (prop.$ref && prop["x-arktype"]?.endsWith("[]")) {
          const referencedDefName = prop.$ref.replace("#/$defs/", "");
          const referencedDef = defs[referencedDefName];

          if (referencedDef?.type === "array" && referencedDef.items?.$ref) {
            // Replace with inline array structure
            def.properties[propName] = {
              type: "array",
              items: {
                $ref: referencedDef.items.$ref, // This will be remapped later
              },
              "x-reference-type": "array",
              "x-arktype": prop["x-arktype"],
            };
          }
        }
      }
    }
  }
}
