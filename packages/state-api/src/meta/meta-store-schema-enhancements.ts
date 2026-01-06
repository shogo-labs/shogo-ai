/**
 * Schema Entity Enhancements
 * Extracted from meta-store.ts to reduce file size for esbuild wasm
 */

import { getRoot } from "mobx-state-tree"
import type { ModelDescriptor } from "./types"
import { getRuntimeStore } from "./runtime-store-cache"

export function createSchemaEnhancements(baseModels: any) {
  return baseModels.Schema
    .actions((self: any) => ({
      /**
       * Update the content checksum (called when schema content changes)
       */
      setContentChecksum(checksum: string) {
        self.contentChecksum = checksum
      }
    }))
    .views((self: any) => ({
    // === Layer 1: Relationship Views (cached/memoized) ===

    /**
     * All models belonging to this schema
     */
    get models() {
      return getRoot<any>(self).modelCollection.all()
        .filter((m: any) => m.schema === self)
    },

    /**
     * All view definitions belonging to this schema
     */
    get views() {
      return getRoot<any>(self).viewDefinitionCollection.all()
        .filter((v: any) => v.schema === self)
    },

    // === Layer 2: Conversion Views ===

    /**
     * Converts this Schema entity to Enhanced JSON Schema.
     * Uses cached models view.
     */
    get toEnhancedJson(): any {
      const enhancedSchema: any = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: self.name,  // Preserve schema identity for round-trip
        $defs: {}
      }

      // Include schema-level x-persistence if present
      if (self.xPersistence !== undefined) {
        enhancedSchema["x-persistence"] = { ...self.xPersistence }
      }

      self.models.forEach((model: any) => {
        const modelDef = model.toJsonSchema()

        // Use domain-qualified name if domain exists
        const defKey = model.domain ? `${model.domain}.${model.name}` : model.name
        enhancedSchema.$defs[defKey] = modelDef

        // Always add x-original-name to help MST identify the model
        enhancedSchema.$defs[defKey]["x-original-name"] = model.name
      })

      return enhancedSchema
    },

    /**
     * Converts views to plain object (for metadata serialization)
     */
    get viewsMetadata(): Record<string, any> | undefined {
      if (!self.views || self.views.length === 0) return undefined

      const viewsObj: Record<string, any> = {}
      self.views.forEach((view: any) => {
        viewsObj[view.name] = {
          type: view.type,
          ...(view.collection && { collection: view.collection }),
          ...(view.filter && { filter: view.filter }),
          ...(view.select && { select: view.select }),
          ...(view.dataSource && { dataSource: view.dataSource }),
          ...(view.template && { template: view.template }),
        }
      })
      return viewsObj
    },

    // === NEW Helper Views ===

    /**
     * Extract unique domains from models
     */
    get domains(): string[] {
      return Array.from(new Set(
        self.models
          .filter((m: any) => m.domain)
          .map((m: any) => m.domain as string)
      ))
    },

    /**
     * Get runtime store for this schema
     */
    get runtimeStore() {
      return getRuntimeStore(self.id)
    },

    // === NEW Layer 3: Composition ===

    /**
     * Convert all models to descriptors (composes Model views)
     */
    get toModelDescriptors(): ModelDescriptor[] {
      return self.models.map((m: any) => m.toDescriptor())
    }
  }))
}
