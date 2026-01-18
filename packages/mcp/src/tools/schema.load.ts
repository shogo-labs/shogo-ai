import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import {
  getMetaStore,
  cacheRuntimeStore,
  loadSchema,
  domain,
  FileSystemPersistence,
  isS3Enabled
} from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"
import { getGlobalBackendRegistry, getWorkspaceBackendRegistry } from "../postgres-init"

const Params = t({
  name: "string",
  workspace: "string?"
})

export function registerSchemaLoad(server: FastMCP) {
  server.addTool({
    name: "schema.load",
    description: "Load a saved schema from disk and create runtime store. Always reloads from disk (hot-reload semantics). Use store.query to retrieve data.",
    parameters: Params,
    execute: async (args: any) => {
      const { name, workspace } = args as { name: string; workspace?: string }

      // Debug: Log received workspace value
      console.log('[schema.load] Received request:', { name, workspace, workspaceType: typeof workspace })

      // If no workspace provided, use monorepo's .schemas directory
      const effectiveWorkspace = getEffectiveWorkspace(workspace)
      console.log('[schema.load] Effective workspace:', effectiveWorkspace)

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

        // 3. Create domain from enhanced schema
        // domain() computes and injects all SQL metadata (columnPropertyMaps,
        // propertyTypeMaps, arrayReferenceMaps) into the environment automatically
        // All collection mixins enabled by default (persistence, queryable, mutatable)
        const enhancedWithMetadata = schema.toEnhancedJson
        const d = domain({
          name: schema.name,
          from: enhancedWithMetadata
        })

        // 4. Create runtime store with environment
        // domain().createStore() handles injecting SQL metadata maps
        // 
        // Backend selection logic:
        // - If schema has x-persistence.backend: 'postgres', use global PostgreSQL
        //   (for system schemas like studio-core, billing, etc.)
        // - If S3 mode enabled and workspace provided, use workspace-specific SQLite
        //   (for user-created app schemas stored in S3)
        // - Otherwise, use global backend (postgres or sqlite depending on config)
        const schemaBackend = enhanced['x-persistence']?.backend
        const usePostgres = schemaBackend === 'postgres'
        
        const backendRegistry = usePostgres
          ? getGlobalBackendRegistry()  // System schemas → PostgreSQL
          : (isS3Enabled() && workspace
              ? await getWorkspaceBackendRegistry(workspace)  // User schemas → S3 SQLite
              : getGlobalBackendRegistry())

        const runtimeStore = d.createStore({
          services: {
            persistence: new FileSystemPersistence(),
            backendRegistry
          },
          context: {
            schemaName: schema.name,
            location: effectiveWorkspace
          }
        })

        // 6. Cache runtime store (with workspace for proper isolation)
        console.log('[schema.load] Caching runtime store for schema:', schema.id, 'with workspace:', effectiveWorkspace)
        cacheRuntimeStore(schema.id, runtimeStore, effectiveWorkspace)

        // 7. Build response using schema views
        const models = schema.toModelDescriptors

        return JSON.stringify({
          ok: true,
          schemaId: schema.id,
          models,
          // Include full enhanced schema for browser-side meta-store ingestion
          // This preserves x-renderer, format, and all other extensions
          enhanced: enhancedWithMetadata,
          loadedCollections: [],  // No auto-loading - use store.query to load data
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
