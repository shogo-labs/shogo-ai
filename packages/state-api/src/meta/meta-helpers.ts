/**
 * Meta-Helpers: Low-level utility functions for meta-layer operations
 *
 * These helpers perform recursive operations that are easier to implement
 * as standalone functions rather than MST actions.
 */

import { v4 as uuidv4 } from "uuid"

/**
 * Recursively ingests a property and its nested structures into the meta-store.
 *
 * This handles:
 * - Core JSON Schema fields (type, format, constraints, etc.)
 * - x-* extensions (mapped to camelCase)
 * - Nested properties (object.properties, array.items)
 * - Composition operators (oneOf, anyOf, allOf)
 *
 * @param metaStore - The meta-store instance with propertyCollection
 * @param propName - Name of the property
 * @param propSchema - JSON Schema for this property
 * @param modelId - ID of the parent Model
 * @param parentPropertyId - ID of parent Property (for nesting)
 * @param nestingType - How this property is nested
 * @param requiredSet - Set of required property names
 * @returns The created Property entity ID
 */
export function ingestProperty(
  metaStore: any,
  propName: string,
  propSchema: any,
  modelId: string,
  parentPropertyId?: string,
  nestingType?: string,
  requiredSet?: Set<string>
): string {
  const propId = uuidv4()

  // Extract core JSON Schema fields
  const propertyData: any = {
    id: propId,
    model: modelId,
    name: propName,
  }

  // Set parent references for nested properties
  if (parentPropertyId) {
    propertyData.parentProperty = parentPropertyId
    propertyData.nestingType = nestingType
  }

  // Only add defined fields
  if (propSchema.type !== undefined) propertyData.type = propSchema.type
  if (propSchema.format !== undefined) propertyData.format = propSchema.format
  if (propSchema.title !== undefined) propertyData.title = propSchema.title
  if (propSchema.description !== undefined) propertyData.description = propSchema.description

  // Extract constraints
  if (propSchema.minLength !== undefined) propertyData.minLength = propSchema.minLength
  if (propSchema.maxLength !== undefined) propertyData.maxLength = propSchema.maxLength
  if (propSchema.minimum !== undefined) propertyData.minimum = propSchema.minimum
  if (propSchema.maximum !== undefined) propertyData.maximum = propSchema.maximum
  if (propSchema.pattern !== undefined) propertyData.pattern = propSchema.pattern
  if (propSchema.enum !== undefined) propertyData.enum = propSchema.enum
  if (propSchema.const !== undefined) propertyData.const = propSchema.const
  if (propSchema.default !== undefined) propertyData.default = propSchema.default

  // Extract $ref
  if (propSchema.$ref !== undefined) propertyData.$ref = propSchema.$ref

  // Map x-* extensions to camelCase fields
  if (propSchema["x-arktype"] !== undefined) propertyData.xArktype = propSchema["x-arktype"]
  if (propSchema["x-mst-type"] !== undefined) propertyData.xMstType = propSchema["x-mst-type"]
  if (propSchema["x-reference-type"] !== undefined) propertyData.xReferenceType = propSchema["x-reference-type"]
  if (propSchema["x-reference-target"] !== undefined) propertyData.xReferenceTarget = propSchema["x-reference-target"]
  if (propSchema["x-computed"] !== undefined) propertyData.xComputed = propSchema["x-computed"]
  if (propSchema["x-inverse"] !== undefined) propertyData.xInverse = propSchema["x-inverse"]
  if (propSchema["x-original-name"] !== undefined) propertyData.xOriginalName = propSchema["x-original-name"]

  // Track required (exclude computed properties)
  if (requiredSet && requiredSet.has(propName) && !propSchema["x-computed"]) {
    propertyData.required = true
  }

  // Create Property entity
  metaStore.propertyCollection.add(propertyData)

  // Recursively handle nested structures

  // Nested object properties
  if (propSchema.properties) {
    for (const [childName, childSchema] of Object.entries(propSchema.properties)) {
      ingestProperty(metaStore, childName, childSchema, modelId, propId, "properties")
    }
  }

  // Array items
  if (propSchema.items) {
    // Items doesn't have a name, use empty string
    ingestProperty(metaStore, "", propSchema.items, modelId, propId, "items")
  }

  // Composition operators
  if (propSchema.oneOf) {
    propSchema.oneOf.forEach((schema: any, i: number) => {
      ingestProperty(metaStore, `oneOf_${i}`, schema, modelId, propId, "oneOf")
    })
  }

  if (propSchema.anyOf) {
    propSchema.anyOf.forEach((schema: any, i: number) => {
      ingestProperty(metaStore, `anyOf_${i}`, schema, modelId, propId, "anyOf")
    })
  }

  if (propSchema.allOf) {
    propSchema.allOf.forEach((schema: any, i: number) => {
      ingestProperty(metaStore, `allOf_${i}`, schema, modelId, propId, "allOf")
    })
  }

  return propId
}
