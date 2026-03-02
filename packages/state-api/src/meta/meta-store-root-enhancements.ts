/**
 * Root Store Enhancements
 * Extracted from meta-store.ts to reduce file size for esbuild wasm
 */

import { getEnv } from "mobx-state-tree"
import { v4 as uuidv4 } from "uuid"
import type { IEnvironment } from "../environment/types"
import { enhancedJsonSchemaToMST } from "../schematic/enhanced-json-schema-to-mst"
import { buildEnhanceCollections } from "../composition/enhance-collections"
import { getRuntimeStore, cacheRuntimeStore, removeRuntimeStoresForSchema } from "./runtime-store-cache"
import { ingestProperty } from "./meta-helpers"
import { getEnhancements } from "../domain/enhancement-registry"
import { computeSchemaChecksum } from "../ddl/migration-tracker"

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
        // Compute content checksum for change detection
        const incomingChecksum = computeSchemaChecksum(enhancedSchema)

        // Check if schema with this name already exists
        const existingSchema = self.findSchemaByName(metadata.name)
        if (existingSchema) {
          // Check if content is IDENTICAL (true idempotent call - React StrictMode safe)
          if (existingSchema.contentChecksum === incomingChecksum) {
            // console.log('[meta-store] Schema unchanged (idempotent):', metadata.name)
            return existingSchema
          }

          // Content differs - UPDATE the existing schema
          // console.log('[meta-store] Schema content changed, updating:', metadata.name)
          self.updateSchemaContent(existingSchema.id, enhancedSchema, incomingChecksum, metadata.views)
          return existingSchema
        }

        // Create Schema entity
        const schemaData: any = {
          id: metadata.id || uuidv4(),
          name: metadata.name,
          format: "enhanced-json-schema",
          createdAt: metadata.createdAt || Date.now(),
          contentChecksum: incomingChecksum,
        }

        // Capture schema-level x-persistence extension
        if (enhancedSchema['x-persistence']) {
          schemaData.xPersistence = enhancedSchema['x-persistence']
        }

        const schema = self.schemaCollection.add(schemaData)

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

          // Capture x-persistence extension for partitioned storage
          if (defSchema['x-persistence']) {
            modelData.xPersistence = defSchema['x-persistence']
          }

          // Capture x-authorization extension for scope-based access control
          if (defSchema['x-authorization']) {
            modelData.xAuthorization = defSchema['x-authorization']
          }

          self.modelCollection.add(modelData)

          // Ingest properties using helper (for recursion)
          const requiredSet = new Set<string>(defSchema.required || [])
          Object.entries(defSchema.properties || {}).forEach(([propName, propSchema]) => {
            ingestProperty(self, propName, propSchema, modelId, undefined, undefined, requiredSet)
          })
        })

        return schema
      },

      /**
       * Updates schema content when checksum differs.
       *
       * Performs cascade update:
       * 1. Delete old properties and models
       * 2. Update schema checksum
       * 3. Re-ingest new models/properties
       * 4. Update views
       * 5. Invalidate runtime store cache
       *
       * @param schemaId - ID of the schema to update
       * @param enhancedSchema - New schema content
       * @param newChecksum - Computed checksum of new content
       * @param views - Optional view definitions
       */
      updateSchemaContent(
        schemaId: string,
        enhancedSchema: any,
        newChecksum: string,
        views?: Record<string, any>
      ) {
        const schema = self.schemaCollection.get(schemaId)
        if (!schema) return

        // 1. Get models/properties to remove (like removeSchema pattern)
        const modelsToRemove = self.modelCollection.all()
          .filter((m: any) => m.schema?.id === schemaId)
        const modelIds = new Set(modelsToRemove.map((m: any) => m.id))
        const propertiesToRemove = self.propertyCollection.all()
          .filter((p: any) => modelIds.has(p.model?.id))

        // Get existing views to remove
        const viewsToRemove = self.viewDefinitionCollection.all()
          .filter((v: any) => v.schema?.id === schemaId)

        // 2. Delete old properties, views, and models
        for (const prop of propertiesToRemove) {
          self.propertyCollection.remove(prop.id)
        }
        for (const view of viewsToRemove) {
          self.viewDefinitionCollection.remove(view.id)
        }
        for (const model of modelsToRemove) {
          self.modelCollection.remove(model.id)
        }

        // 3. Update schema checksum
        schema.setContentChecksum(newChecksum)

        // 4. Update schema-level x-persistence if changed
        if (enhancedSchema['x-persistence']) {
          schema.xPersistence = enhancedSchema['x-persistence']
        }

        // 5. Re-ingest views if provided
        if (views) {
          Object.entries(views).forEach(([viewName, viewDef]: [string, any]) => {
            self.viewDefinitionCollection.add({
              id: uuidv4(),
              schema: schemaId,
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

        // 6. Re-ingest new models/properties (same logic as ingestEnhancedJsonSchema)
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
            schema: schemaId,
            name: possibleName || defKey,
          }

          if (possibleDomain) modelData.domain = possibleDomain
          if (defSchema.description) modelData.description = defSchema.description

          // Capture x-persistence extension for partitioned storage
          if (defSchema['x-persistence']) {
            modelData.xPersistence = defSchema['x-persistence']
          }

          // Capture x-authorization extension for scope-based access control
          if (defSchema['x-authorization']) {
            modelData.xAuthorization = defSchema['x-authorization']
          }

          self.modelCollection.add(modelData)

          // Ingest properties using helper (for recursion)
          const requiredSet = new Set<string>(defSchema.required || [])
          Object.entries(defSchema.properties || {}).forEach(([propName, propSchema]) => {
            ingestProperty(self, propName, propSchema, modelId, undefined, undefined, requiredSet)
          })
        })

        // 7. Invalidate runtime store cache for this schema
        removeRuntimeStoresForSchema(schemaId)
      },

      /**
       * Isomorphic schema loading action.
       *
       * Loads a schema by name, creating runtime store with persistence composed.
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
        const metaEnv = getEnv<IEnvironment>(self)
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

        // 4. Look up registered enhancements from domain() API
        const registeredEnhancements = getEnhancements(schema.name)

        // 5. Create runtime store with MST composition
        // Use shared buildEnhanceCollections utility (always enables persistence for loadSchema)
        const { createStore } = enhancedJsonSchemaToMST(schema.toEnhancedJson, {
          generateActions: true,
          enhanceModels: registeredEnhancements?.models,
          enhanceCollections: buildEnhanceCollections(registeredEnhancements?.collections, true),
          enhanceRootStore: registeredEnhancements?.rootStore,
        })

        // 6. Create environment with services (pass through from meta-store env)
        // Extract backendRegistry from meta-store's environment, or create default
        let backendRegistry = metaEnv?.services?.backendRegistry

        if (!backendRegistry) {
          // Fallback: Create default MemoryBackend registry if not provided
          // Import here to avoid circular dependency
          const { createBackendRegistry } = await import("../query/registry")
          const { MemoryBackend } = await import("../query/backends/memory")

          backendRegistry = createBackendRegistry({
            default: 'memory',
            backends: { memory: new MemoryBackend() }
          })
        }

        const env: IEnvironment = {
          services: {
            persistence: persistence!,
            backendRegistry
          },
          context: { schemaName: schema.name, location: workspace }
        }

        // 7. Create and cache runtime store
        const runtimeStore = createStore(env)
        cacheRuntimeStore(schema.id, runtimeStore, workspace)

        return schema
      },

      /**
       * Removes a schema and all related entities from the meta-store.
       *
       * Performs cascade deletion in this order:
       * 1. Properties (must be deleted before Models due to references)
       * 2. ViewDefinitions (reference Schema directly)
       * 3. Models (reference Schema)
       * 4. Schema itself
       *
       * Also invalidates all cached runtime stores for this schema
       * across all workspaces.
       *
       * @param schemaName - Name of the schema to remove
       * @returns true if schema was found and removed, false if not found
       */
      removeSchema(schemaName: string): boolean {
        const schema = self.findSchemaByName(schemaName)
        if (!schema) {
          return false
        }

        const schemaId = schema.id

        // 1. Get all models for this schema
        const modelsToRemove = self.modelCollection.all()
          .filter((m: any) => m.schema?.id === schemaId)

        // 2. Get all properties for those models
        const modelIds = new Set(modelsToRemove.map((m: any) => m.id))
        const propertiesToRemove = self.propertyCollection.all()
          .filter((p: any) => modelIds.has(p.model?.id))

        // 3. Get all view definitions for this schema
        const viewsToRemove = self.viewDefinitionCollection.all()
          .filter((v: any) => v.schema?.id === schemaId)

        // 4. Delete in reverse dependency order: Properties -> Views -> Models -> Schema
        for (const prop of propertiesToRemove) {
          self.propertyCollection.remove(prop.id)
        }

        for (const view of viewsToRemove) {
          self.viewDefinitionCollection.remove(view.id)
        }

        for (const model of modelsToRemove) {
          self.modelCollection.remove(model.id)
        }

        self.schemaCollection.remove(schemaId)

        // 5. Invalidate all runtime store caches for this schema (across all workspaces)
        removeRuntimeStoresForSchema(schemaId)

        return true
      }
    }))
}
