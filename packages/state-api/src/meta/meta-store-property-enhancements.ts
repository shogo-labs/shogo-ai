/**
 * Property Model Enhancements
 * Extracted from meta-store.ts to reduce file size for esbuild wasm
 */

import { getRoot } from "mobx-state-tree"
import type { ModelField, ModelRef } from "./types"
import { getColumnName } from "../ddl/utils"

export function createPropertyEnhancements(baseModels: any) {
  return baseModels.Property.views((self: any) => ({
    // === Layer 1: Relationship Views (cached/memoized) ===

    /**
     * All child properties (nested via parentProperty reference)
     */
    get children() {
      return getRoot<any>(self).propertyCollection.all()
        .filter((p: any) => p.parentProperty === self)
    },

    /**
     * Child properties nested as object.properties
     */
    get propertiesChildren() {
      return self.children.filter((p: any) => p.nestingType === "properties")
    },

    /**
     * Child property nested as array.items (single item)
     */
    get itemsChild() {
      return self.children.find((p: any) => p.nestingType === "items")
    },

    /**
     * Child properties nested in oneOf composition
     */
    get oneOfChildren() {
      return self.children.filter((p: any) => p.nestingType === "oneOf")
    },

    /**
     * Child properties nested in anyOf composition
     */
    get anyOfChildren() {
      return self.children.filter((p: any) => p.nestingType === "anyOf")
    },

    /**
     * Child properties nested in allOf composition
     */
    get allOfChildren() {
      return self.children.filter((p: any) => p.nestingType === "allOf")
    },

    // === Layer 2: Conversion Views (compose Layer 1) ===

    /**
     * Converts this Property entity to JSON Schema property definition.
     * Uses cached relationship views for nested structures.
     */
    toJsonSchema(): any {
      const prop: any = {}

      // Handle $ref early return (references don't need other fields)
      if (self.$ref) {
        prop.$ref = self.$ref
        if (self.xReferenceType) prop["x-reference-type"] = self.xReferenceType
        if (self.xArktype) prop["x-arktype"] = self.xArktype
        return prop
      }

      // Core JSON Schema fields
      if (self.type !== undefined) prop.type = self.type
      if (self.format !== undefined) prop.format = self.format
      if (self.title !== undefined) prop.title = self.title
      if (self.description !== undefined) prop.description = self.description

      // Constraints
      if (self.minLength !== undefined) prop.minLength = self.minLength
      if (self.maxLength !== undefined) prop.maxLength = self.maxLength
      if (self.minimum !== undefined) prop.minimum = self.minimum
      if (self.maximum !== undefined) prop.maximum = self.maximum
      if (self.pattern !== undefined) prop.pattern = self.pattern
      if (self.enum !== undefined && self.enum.length > 0) prop.enum = self.enum
      if (self.const !== undefined) prop.const = self.const
      if (self.default !== undefined) prop.default = self.default

      // x-* extensions (camelCase → kebab-case)
      if (self.xArktype !== undefined) prop["x-arktype"] = self.xArktype
      if (self.xMstType !== undefined) prop["x-mst-type"] = self.xMstType
      if (self.xReferenceType !== undefined) prop["x-reference-type"] = self.xReferenceType
      if (self.xReferenceTarget !== undefined) prop["x-reference-target"] = self.xReferenceTarget
      if (self.xComputed !== undefined) prop["x-computed"] = self.xComputed
      if (self.xInverse !== undefined) prop["x-inverse"] = self.xInverse
      if (self.xOriginalName !== undefined) prop["x-original-name"] = self.xOriginalName
      if (self.xRenderer !== undefined) prop["x-renderer"] = self.xRenderer

      // Reconstruct nested structure using cached views

      // Nested properties (object.properties)
      if (self.propertiesChildren.length > 0) {
        prop.properties = {}
        self.propertiesChildren.forEach((child: any) => {
          prop.properties[child.name] = child.toJsonSchema()
        })
      }

      // Array items
      if (self.itemsChild) {
        prop.items = self.itemsChild.toJsonSchema()
      }

      // Composition operators
      if (self.oneOfChildren.length > 0) {
        prop.oneOf = self.oneOfChildren.map((child: any) => child.toJsonSchema())
      }

      if (self.anyOfChildren.length > 0) {
        prop.anyOf = self.anyOfChildren.map((child: any) => child.toJsonSchema())
      }

      if (self.allOfChildren.length > 0) {
        prop.allOf = self.allOfChildren.map((child: any) => child.toJsonSchema())
      }

      return prop
    },

    // === NEW Layer 2: Additional Conversions ===

    /**
     * Extract $ref target (e.g., "#/$defs/Task" → "Task")
     */
    get refTarget(): string | undefined {
      return self.$ref?.replace("#/$defs/", "")
    },

    /**
     * Convert to ModelField descriptor
     */
    toFieldDescriptor(): ModelField {
      const computed = self.xComputed === true
      let typeLabel = self.type || "unknown"

      if (self.$ref) typeLabel = "reference"

      const refType = self.xReferenceType as undefined | "single" | "array"
      if (refType === "single") {
        typeLabel = "reference"
      } else if (refType === "array") {
        typeLabel = "reference[]"
      }

      return {
        name: self.name,
        type: typeLabel,
        required: self.required || false,
        ...(computed ? { computed: true } : {})
      }
    },

    /**
     * Convert to ModelRef descriptors
     */
    toRefDescriptors(): ModelRef[] {
      const refs: ModelRef[] = []
      const refType = self.xReferenceType as undefined | "single" | "array"

      if (refType === "single" && self.refTarget) {
        refs.push({
          field: self.name,
          target: self.refTarget,
          kind: "single"
        })
      } else if (refType === "array") {
        const itemsChild = self.itemsChild
        if (itemsChild?.refTarget) {
          refs.push({
            field: self.name,
            target: itemsChild.refTarget,
            kind: "array"
          })
        }
      }

      return refs
    },

    // === Layer 3: SQL Column Mapping ===

    /**
     * Database column name for this property.
     *
     * For single references: uses DDL convention `<target>_id`
     * (mirrors constraint-builder.ts line 185)
     *
     * For regular properties: simple snake_case of property name
     *
     * @example
     * // Reference property with x-reference-target: "Organization"
     * property.columnName // => "organization_id"
     *
     * // Regular property named "departmentName"
     * property.columnName // => "department_name"
     */
    get columnName(): string {
      // Use canonical helper for column naming (single source of truth)
      return getColumnName(self.name, self.xReferenceTarget, self.xReferenceType)
    }
  }))
}
