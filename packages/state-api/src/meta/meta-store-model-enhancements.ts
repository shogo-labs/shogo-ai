/**
 * Model Entity Enhancements
 * Extracted from meta-store.ts to reduce file size for esbuild wasm
 */

import { getRoot, getSnapshot } from "mobx-state-tree"
import type { ModelDescriptor } from "./types"
import { camelCase } from "../utils/string"

export function createModelEnhancements(baseModels: any) {
  return baseModels.Model.views((self: any) => ({
    // === Layer 1: Relationship Views (cached/memoized) ===

    /**
     * Top-level properties for this model (no parentProperty)
     */
    get properties() {
      return getRoot<any>(self).propertyCollection.all()
        .filter((p: any) => p.model === self && !p.parentProperty)
    },

    /**
     * Names of required properties (excluding computed)
     */
    get requiredPropertyNames() {
      return self.properties
        .filter((p: any) => p.required && !p.xComputed)
        .map((p: any) => p.name)
    },

    // === Layer 2: Conversion Views ===

    /**
     * Converts this Model entity to JSON Schema definition.
     * Uses cached properties view.
     */
    toJsonSchema(): any {
      const def: any = {
        type: "object"
      }

      if (self.description !== undefined) def.description = self.description
      if (self.domain !== undefined) def["x-domain"] = self.domain

      // Output x-persistence if present (partitioned storage config)
      // Use getSnapshot() to convert MST observable to plain JSON-serializable object
      if (self.xPersistence !== undefined) {
        def["x-persistence"] = getSnapshot(self.xPersistence)
      }

      // Output x-authorization if present (scope-based access control)
      if (self.xAuthorization !== undefined) {
        def["x-authorization"] = getSnapshot(self.xAuthorization)
      }

      if (self.properties.length > 0) {
        def.properties = {}

        self.properties.forEach((prop: any) => {
          def.properties[prop.name] = prop.toJsonSchema()
        })

        if (self.requiredPropertyNames.length > 0) {
          def.required = self.requiredPropertyNames
        }
      }

      return def
    },

    // === NEW Helper Views ===

    /**
     * Qualified name with domain (e.g., "auth.User" or "Task")
     */
    get qualifiedName(): string {
      return self.domain ? `${self.domain}.${self.name}` : self.name
    },

    /**
     * Collection name for runtime store (e.g., "taskCollection")
     */
    get collectionName(): string {
      return camelCase(self.name) + "Collection"
    },

    // === NEW Layer 3: Composition ===

    /**
     * Convert to ModelDescriptor (composes Property views)
     */
    toDescriptor(): ModelDescriptor {
      const fields = self.properties.map((p: any) => p.toFieldDescriptor())
      const refs = self.properties.flatMap((p: any) => p.toRefDescriptors())

      return {
        name: self.qualifiedName,
        collectionName: self.collectionName,
        fields,
        ...(refs.length > 0 ? { refs } : {})
      }
    },

    // === Layer 4: SQL Column Mapping ===

    /**
     * Mapping from database column names to property names.
     *
     * Composes Property.columnName views to build a complete map.
     * Used by SqlQueryExecutor for bidirectional field normalization:
     * - Input: property name → column name (via inverse of this map)
     * - Output: column name → property name (this map)
     *
     * @example
     * // Model with properties: id, name, organization (ref to Organization)
     * model.columnPropertyMap
     * // => { id: "id", name: "name", organization_id: "organization" }
     */
    get columnPropertyMap(): Record<string, string> {
      const map: Record<string, string> = {}
      for (const prop of self.properties) {
        map[prop.columnName] = prop.name
      }
      return map
    }
  }))
}
