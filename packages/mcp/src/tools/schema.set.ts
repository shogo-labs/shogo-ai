import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { types } from "mobx-state-tree"
import { getMetaStore } from "@shogo/state-api"
import { cacheRuntimeStore } from "@shogo/state-api"
import { enhancedJsonSchemaToMST } from "@shogo/state-api"
import { saveSchema } from "@shogo/state-api"
import { CollectionPersistable } from "@shogo/state-api"
import { FileSystemPersistence } from "@shogo/state-api"
import type { IEnvironment } from "@shogo/state-api"
import { getEffectiveWorkspace } from "../state"

const Params = t({
  name: "string",
  format: "'enhanced-json-schema' | 'arktype'",
  payload: "object",
  workspace: "string?",
  "views?": "Record<string, unknown>",
  "templates?": "Record<string, string>",
  "options?": {
    validateReferences: "boolean?",
  },
})

export function registerSchemaSet(server: FastMCP) {
  server.addTool({
    name: "schema.set",
    description: "Set the active schema and rebuild in-memory models (data is reset)",
    parameters: Params,
    execute: async (args: any) => {
      const { name, format, payload, workspace, views, templates, options } = args as {
        name: string;
        format: string;
        payload: unknown;
        workspace?: string;
        views?: Record<string, any>;
        templates?: Record<string, string>;
        options?: { validateReferences?: boolean }
      }

      // If no workspace provided, use monorepo's .schemas directory
      const effectiveWorkspace = getEffectiveWorkspace(workspace)

      if (format === "enhanced-json-schema") {
        if (!payload || typeof payload !== "object") {
          return JSON.stringify({ ok: false, error: { code: "SCHEMA_PARSE_ERROR", message: "payload must be an object" } })
        }

        const enhanced = payload as Record<string, any>
        const defs = (enhanced as any).$defs
        if (!defs || typeof defs !== "object") {
          return JSON.stringify({ ok: false, error: { code: "SCHEMA_PARSE_ERROR", message: "payload.$defs is required" } })
        }

        try {
          // 1. Ingest into meta-store (stores metadata about the schema)
          const metaStore = getMetaStore()
          const schema = metaStore.ingestEnhancedJsonSchema(enhanced, { name, ...(views && { views }) })

          // 2. Generate runtime MST store (reactive data layer)
          // Use meta-store's output (includes x-original-name for MST)
          const enhancedWithMetadata = schema.toEnhancedJson
          const { createStore } = enhancedJsonSchemaToMST(enhancedWithMetadata, {
            generateActions: true,
            validateReferences: options?.validateReferences ?? false,

            // Unit 5: Enhance collections with persistence mixin
            enhanceCollections: (baseCollections) => {
              const enhanced: Record<string, any> = {}
              for (const [name, model] of Object.entries(baseCollections)) {
                enhanced[name] = types.compose(model, CollectionPersistable).named(name)
              }
              return enhanced
            }
          })

          // 3. Create environment with persistence service
          const env: IEnvironment = {
            services: {
              persistence: new FileSystemPersistence()
            },
            context: {
              schemaName: schema.name,  // Use string name instead of entity
              location: effectiveWorkspace
            }
          }

          // 4. Create runtime store with environment
          const runtimeStore = createStore(env)

          // 5. Cache runtime store by schema ID + workspace (Unit 3: workspace-aware caching)
          cacheRuntimeStore(schema.id, runtimeStore, effectiveWorkspace)

          // 6. Auto-save schema to disk (with templates if provided)
          const savedPath = await saveSchema(schema, templates, effectiveWorkspace)

          // 7. Build response using schema views
          const models = schema.toModelDescriptors
          const domains = schema.domains

          return JSON.stringify({
            ok: true,
            schemaId: schema.id,
            path: savedPath,
            models,
            ...(domains.length ? { domains } : {})
          })
        } catch (error: any) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "SCHEMA_INGESTION_ERROR",
              message: error.message || "Failed to ingest schema"
            }
          })
        }
      }

      // ArkType path not yet implemented
      return JSON.stringify({ ok: false, error: { code: "UNSUPPORTED_FORMAT", message: "Only 'enhanced-json-schema' supported in MVP-1" } })
    },
  })
}
