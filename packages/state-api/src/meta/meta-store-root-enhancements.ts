/**
 * Root Store Enhancements
 * Extracted from meta-store.ts to reduce file size for esbuild wasm
 */

import { getEnv, types } from "mobx-state-tree"
import { v4 as uuidv4 } from "uuid"
import type { IEnvironment, IMetaStoreEnvironment } from "../environment/types"
import { enhancedJsonSchemaToMST } from "../schematic/enhanced-json-schema-to-mst"
import { CollectionPersistable } from "../composition/persistable"
import { getRuntimeStore, cacheRuntimeStore } from "./runtime-store-cache"
import { ingestProperty } from "./meta-helpers"

export function createRootStoreEnhancements(RootModel: any) {
  return RootModel
    .views((self: any) => ({
      // === Layer 4: Store-Level Finders ===

      /**
       * Find schema by name
       */
      findSchemaByName(name: string) {
        return self.schemaCollection.all()
          .find((s: any) => s.name === name)
      },

      /**
       * Find model by name (searches across all schemas)
       */
      findModelByName(name: string) {
        return self.modelCollection.all()
          .find((m: any) => m.name === name)
      }
    }))
    .actions((self: any) => ({
      ingestEnhancedJsonSchema(
        enhancedSchema: any,
        metadata: { id?: string; name: string; createdAt?: number; views?: Record<string, any> }
      ) {
        // Check if schema with this name already exists (idempotency for React StrictMode)
        const existingSchema = self.findSchemaByName(metadata.name)
        if (existingSchema) {
          console.log('[meta-store] Schema already exists:', metadata.name)
          console.log('[meta-store] Existing schema ID:', existingSchema.id, 'models:', existingSchema.models?.length)
          console.log('[meta-store] Incoming metadata ID:', metadata.id)
          // Return existing to avoid duplicates - the IDs should match if from same source
          return existingSchema
        }

        // Create Schema entity
        const schema = self.schemaCollection.add({
          id: metadata.id || uuidv4(),
          name: metadata.name,
          format: "enhanced-json-schema",
          createdAt: metadata.createdAt || Date.now(),
        })

        // Ingest views if provided
        if (metadata.views) {
          Object.entries(metadata.views).forEach(([viewName, viewDef]: [string, any]) => {
            self.viewDefinitionCollection.add({
              id: uuidv4(),
              schema: schema.id,
              name: viewName,
              type: viewDef.type,
              ...(viewDef.collection && { collection: viewDef.collection }),
              ...(viewDef.filter && { filter: viewDef.filter }),
              ...(viewDef.select && { select: viewDef.select }),
              ...(viewDef.dataSource && { dataSource: viewDef.dataSource }),
              ...(viewDef.template && { template: viewDef.template }),
            })
          })
        }

        // Extract definitions
        let defs = enhancedSchema.$defs || {}

        // Handle single-type schemas (no $defs but has properties)
        if (Object.keys(defs).length === 0 && enhancedSchema.type === "object" && enhancedSchema.properties) {
          const typeName = enhancedSchema["x-original-name"] || "Model"
          defs = {
            [typeName]: {
              type: "object",
              properties: enhancedSchema.properties,
              required: enhancedSchema.required,
              description: enhancedSchema.description
            }
          }
        }

        // Parse $defs into Model/Property entities
        Object.entries(defs).forEach(([defKey, defSchema]: [string, any]) => {
          // Extract domain if present (e.g., "auth.User" → domain="auth", name="User")
          const [possibleDomain, possibleName] = defKey.includes('.')
            ? defKey.split('.')
            : [undefined, defKey]

          const modelId = uuidv4()
          const modelData: any = {
            id: modelId,
            schema: schema.id,
            name: possibleName || defKey,
          }

          if (possibleDomain) modelData.domain = possibleDomain
          if (defSchema.description) modelData.description = defSchema.description

          self.modelCollection.add(modelData)

          // Ingest properties using helper (for recursion)
          const requiredSet = new Set(defSchema.required || [])
          Object.entries(defSchema.properties || {}).forEach(([propName, propSchema]) => {
            ingestProperty(self, propName, propSchema, modelId, undefined, undefined, requiredSet)
          })
        })

        return schema
      },

      /**
       * Isomorphic schema loading action.
       *
       * Loads a schema by name, creating runtime store with persistence composed.
       * Works identically in Node.js (FileSystemPersistence) and browser (MCPPersistence).
       *
       * Flow:
       * 1. Check if schema already in meta-store
       * 2. If not, load via persistence service
       * 3. Create runtime store with CollectionPersistable mixin
       * 4. Cache runtime store by schema ID + workspace
       *
       * @param name - Schema name to load
       * @param workspace - Optional workspace/location override
       * @returns Schema entity with runtimeStore accessor
       */
      async loadSchema(name: string, workspace?: string) {
        // 1. Check if already in meta-store
        let schema = self.findSchemaByName(name)

        // 2. If not found, load via persistence service (from environment)
        const metaEnv = getEnv<IMetaStoreEnvironment>(self)
        const persistence = metaEnv.services?.persistence

        if (!schema && persistence?.loadSchema) {
          const result = await persistence.loadSchema(name, workspace)
          if (result) {
            schema = self.ingestEnhancedJsonSchema(result.enhanced, result.metadata)
          }
        }

        if (!schema) {
          throw new Error(`Schema '${name}' not found`)
        }

        // 3. Check if runtime store already cached
        const existingStore = getRuntimeStore(schema.id, workspace)
        if (existingStore) {
          return schema
        }

        // 4. Create runtime store with MST composition (same pattern as schema.set.ts)
        const { createStore } = enhancedJsonSchemaToMST(schema.toEnhancedJson, {
          generateActions: true,
          enhanceCollections: (baseCollections) => {
            const enhanced: Record<string, any> = {}
            for (const [n, model] of Object.entries(baseCollections)) {
              enhanced[n] = types.compose(model, CollectionPersistable).named(n)
            }
            return enhanced
          }
        })

        // 5. Create environment with persistence (pass through from meta-store env)
        const env: IEnvironment = {
          services: { persistence: persistence! },
          context: { schemaName: schema.name, location: workspace }
        }

        // 6. Create and cache runtime store
        const runtimeStore = createStore(env)
        cacheRuntimeStore(schema.id, runtimeStore, workspace)

        return schema
      }
    }))
}
