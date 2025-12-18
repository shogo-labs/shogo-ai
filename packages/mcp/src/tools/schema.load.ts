import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getMetaStore } from "@shogo/state-api"
import { cacheRuntimeStore } from "@shogo/state-api"
import { enhancedJsonSchemaToMST } from "@shogo/state-api"
import { loadSchema } from "@shogo/state-api"
import { buildEnhanceCollections } from "@shogo/state-api"
import { FileSystemPersistence } from "@shogo/state-api"
import type { IEnvironment } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"
import { getGlobalBackendRegistry } from "../postgres-init"

const Params = t({
  name: "string",
  workspace: "string?"
})

export function registerSchemaLoad(server: FastMCP) {
  server.addTool({
    name: "schema.load",
    description: "Load a saved schema from disk and create runtime store. Always reloads from disk (hot-reload semantics). Data loading is separate - use data.loadAll.",
    parameters: Params,
    execute: async (args: any) => {
      const { name, workspace } = args as { name: string; workspace?: string }

      // If no workspace provided, use monorepo's .schemas directory
      const effectiveWorkspace = getEffectiveWorkspace(workspace)

      try {
        const metaStore = getMetaStore()

        // === HOT RELOAD: Always invalidate and reload from disk ===

        // 1. Check if schema already exists - if so, remove it (cascade deletes runtime stores too)
        const existingSchema = metaStore.findSchemaByName(name)
        const wasReloaded = !!existingSchema

        if (existingSchema) {
          metaStore.removeSchema(name)
        }

        // 2. Always load fresh from disk
        const { metadata, enhanced } = await loadSchema(name, effectiveWorkspace)
        const schema = metaStore.ingestEnhancedJsonSchema(enhanced, metadata)

        // 3. Generate fresh runtime store
        const enhancedWithMetadata = schema.toEnhancedJson
        const { createStore } = enhancedJsonSchemaToMST(enhancedWithMetadata, {
          generateActions: true,
          validateReferences: false,

          // Enhance collections with all mixins:
          // - CollectionPersistable (file persistence)
          // - CollectionQueryable (IQueryable with MST sync for remote backends)
          // - CollectionMutatable (insertOne, updateOne, deleteOne with backend writes)
          enhanceCollections: buildEnhanceCollections(undefined, true, true, true)
        })

        // 4. Create environment with persistence service and backend registry
        const env: IEnvironment = {
          services: {
            persistence: new FileSystemPersistence(),
            backendRegistry: getGlobalBackendRegistry()
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
          reloaded: wasReloaded  // true if schema existed before and was replaced
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
