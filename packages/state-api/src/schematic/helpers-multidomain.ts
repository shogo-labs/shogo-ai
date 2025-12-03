/**
 * Multi-domain helper functions for arktype-to-json-schema conversion (Phase 4)
 * Handles cross-domain references and computed arrays in multi-domain schemas
 */

import type { Scope } from 'arktype';
import { schemasMatch } from './helpers-foundation';

/**
 * Enhances properties for multi-domain schemas with cross-domain references
 */
export function enhancePropertiesForMultiDomain(
  properties: Record<string, any>,
  typeName: string,
  domainName: string,
  domains: Record<string, Scope<any>>,
  scopeAliases: Record<string, any>
): void {
  const typeAlias = scopeAliases[typeName];

  for (const [propName, propSchema] of Object.entries(properties)) {
    const prop = propSchema as any;
    const arkPropDef = typeAlias?.[propName] || typeAlias?.[`${propName}?`];

    if (arkPropDef && typeof arkPropDef === "string") {
      prop["x-arktype"] = arkPropDef;

      // Check if it's a cross-domain array reference (e.g., "auth.User[]")
      if (arkPropDef.includes(".") && arkPropDef.endsWith("[]")) {
        const cleanRef = arkPropDef.slice(0, -2);
        const [refDomain, refType] = cleanRef.split(".");
        // Only treat as cross-domain reference if the domain exists
        if (domains[refDomain!]) {
          properties[propName] = {
            type: "array",
            items: {
              $ref: `#/$defs/${refDomain}.${refType}`
            },
            "x-reference-type": "array",
            "x-arktype": arkPropDef
          };
        }
      }
      // Check if it's a cross-domain reference (e.g., "auth.User")
      else if (arkPropDef.includes(".")) {
        const [refDomain, refType] = arkPropDef.split(".");
        // Only treat as cross-domain reference if the domain exists
        if (domains[refDomain!]) {
          prop.$ref = `#/$defs/${refDomain}.${refType}`;
          prop["x-reference-type"] = "single";
        }
      }
      // Check for same-domain reference
      else if (scopeAliases[arkPropDef]) {
        prop.$ref = `#/$defs/${domainName}.${arkPropDef}`;
        prop["x-reference-type"] = "single";
      }
      // Check for same-domain array reference
      else if (arkPropDef.endsWith("[]")) {
        const entityName = arkPropDef.slice(0, -2);
        if (scopeAliases[entityName]) {
          properties[propName] = {
            type: "array",
            items: {
              $ref: `#/$defs/${domainName}.${entityName}`
            },
            "x-reference-type": "array",
            "x-arktype": arkPropDef
          };
        }
      }
    }
    // Handle properties that might already be references
    else if (prop.type === "object" && prop.properties) {
      // Try to match with types in the same domain
      const exported = domains[domainName].export();
      for (const [otherTypeName, otherTypeExport] of Object.entries(exported)) {
        if (typeName !== otherTypeName && otherTypeExport &&
          typeof otherTypeExport.toJsonSchema === "function") {
          const otherSchema = otherTypeExport.toJsonSchema() as any;
          if (schemasMatch(prop, otherSchema)) {
            properties[propName] = {
              $ref: `#/$defs/${domainName}.${otherTypeName}`,
              "x-reference-type": "single",
              "x-arktype": otherTypeName
            };
            break;
          }
        }
      }
    }
    // Handle array of objects
    else if (prop.type === "array" && prop.items?.type === "object" && prop.items.properties) {
      const exported = domains[domainName].export();
      for (const [otherTypeName, otherTypeExport] of Object.entries(exported)) {
        if (otherTypeExport && typeof otherTypeExport.toJsonSchema === "function") {
          const otherSchema = otherTypeExport.toJsonSchema() as any;
          if (schemasMatch(prop.items, otherSchema)) {
            properties[propName] = {
              type: "array",
              items: {
                $ref: `#/$defs/${domainName}.${otherTypeName}`
              },
              "x-reference-type": "array",
              "x-arktype": `${otherTypeName}[]`
            };
            break;
          }
        }
      }
    }
  }
}

/**
 * Detects computed arrays in multi-domain schemas
 */
export function detectComputedArraysMultiDomain(defs: Record<string, any>): void {
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
        const targetRef = prop.items?.$ref?.replace("#/$defs/", "") || "";
        if (!targetRef) continue;

        // Look for inverse single reference
        const targetSchema = defs[targetRef];
        if (targetSchema?.properties) {
          for (const [targetProp, targetPropDef] of Object.entries(
            targetSchema.properties
          )) {
            const targetRefProp = targetPropDef as any;

            // Found inverse reference (considering namespacing)
            if (
              targetRefProp.$ref === `#/$defs/${typeName}` &&
              targetRefProp["x-reference-type"] === "single"
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
