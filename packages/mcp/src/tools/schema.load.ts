import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { types } from "mobx-state-tree"
import { getMetaStore } from "@shogo/state-api"
import { cacheRuntimeStore, getRuntimeStore } from "@shogo/state-api"
import { enhancedJsonSchemaToMST } from "@shogo/state-api"
import { loadSchema } from "@shogo/state-api"
import { CollectionPersistable } from "@shogo/state-api"
import { FileSystemPersistence } from "@shogo/state-api"
import type { IEnvironment } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

const Params = t({
  name: "string",
  workspace: "string?"
})

export function registerSchemaLoad(server: FastMCP) {
  server.addTool({
    name: "schema.load",
    description: "Load a saved schema from disk and create/reuse runtime store (data loading is separate - use data.loadAll)",
    parameters: Params,
    execute: async (args: any) => {
      const { name, workspace } = args as { name: string; workspace?: string }

      // If no workspace provided, use monorepo's .schemas directory
      const effectiveWorkspace = getEffectiveWorkspace(workspace)

      try {
        // 1. Check if schema already exists in meta-store
        const metaStore = getMetaStore()
        let schema = metaStore.findSchemaByName(name)

        if (!schema) {
          // Schema not in meta-store - load from disk and ingest
          const { metadata, enhanced } = await loadSchema(name, effectiveWorkspace)
          schema = metaStore.ingestEnhancedJsonSchema(enhanced, metadata)
        }

        // 2. Check if runtime store already exists for this schema + workspace
        const existingStore = getRuntimeStore(schema.id, effectiveWorkspace)

        if (existingStore) {
          // Runtime store already cached - reuse it
          const models = schema.toModelDescriptors

          return JSON.stringify({
            ok: true,
            schemaId: schema.id,
            models,
            loadedCollections: [],  // No data loaded (use data.loadAll for that)
            cached: true
          })
        }

        // 3. Generate runtime store (only if not cached)
        const enhancedWithMetadata = schema.toEnhancedJson
        const { createStore } = enhancedJsonSchemaToMST(enhancedWithMetadata, {
          generateActions: true,
          validateReferences: false,

          // Unit 5: Enhance collections with persistence mixin
          enhanceCollections: (baseCollections) => {
            const enhanced: Record<string, any> = {}
            for (const [name, model] of Object.entries(baseCollections)) {
              enhanced[name] = types.compose(model, CollectionPersistable).named(name)
            }
            return enhanced
          }
        })

        // 4. Create environment with persistence service
        const env: IEnvironment = {
          services: {
            persistence: new FileSystemPersistence()
          },
          context: {
            schemaName: schema.name,  // Use string name instead of entity
            location: effectiveWorkspace
          }
        }

        // 5. Create runtime store with environment
        const runtimeStore = createStore(env)

        // 6. Cache runtime store (with workspace for proper isolation)
        cacheRuntimeStore(schema.id, runtimeStore, effectiveWorkspace)

        // 7. Build response using schema views
        const models = schema.toModelDescriptors

        return JSON.stringify({
          ok: true,
          schemaId: schema.id,
          models,
          loadedCollections: [],  // No auto-loading - use data.loadAll instead
          cached: false
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: error.code === 'ENOENT' ? 'SCHEMA_NOT_FOUND' : 'LOAD_ERROR',
            message: error.code === 'ENOENT'
              ? `Schema '${name}' not found in workspace: ${effectiveWorkspace}`
              : error.message || `Failed to load schema '${name}'`
          }
        })
      }
    }
  })
}
