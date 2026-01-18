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

// Parameter schema
const Params = t({
  name: "string",
  "payload?": "object",
  "schema?": "string | object",
  "workspace?": "string",
  "views?": "Record<string, unknown>",
  "templates?": "Record<string, string>",
  "options?": {
    validateReferences: "boolean?",
  },
})

/**
 * Validates an Enhanced JSON Schema and returns detailed error messages
 */
function validateEnhancedJsonSchema(payload: any, name: string): { valid: boolean; error?: any; enhanced?: any } {
  // Check payload is an object
  if (!payload || typeof payload !== 'object') {
    return {
      valid: false,
      error: {
        code: "INVALID_PAYLOAD",
        message: "Schema payload must be an object",
        received: typeof payload,
      }
    }
  }

  const keys = Object.keys(payload)

  // Check for $defs (required for Enhanced JSON Schema)
  if (!payload.$defs) {
    return {
      valid: false,
      error: {
        code: "MISSING_DEFS",
        message: "Schema is missing required '$defs' property",
        receivedKeys: keys.join(', '),
        requiredFormat: {
          description: "Enhanced JSON Schema format",
          example: {
            "$defs": {
              "Category": {
                "type": "object",
                "x-original-name": "Category",
                "properties": {
                  "id": { "type": "string", "x-mst-type": "identifier" },
                  "name": { "type": "string" },
                  "color": { "type": "string" }
                },
                "required": ["id", "name"]
              },
              "Task": {
                "type": "object",
                "x-original-name": "Task",
                "properties": {
                  "id": { "type": "string", "x-mst-type": "identifier" },
                  "title": { "type": "string" },
                  "categoryId": { "type": "string" },
                  "status": { "type": "string", "enum": ["pending", "done"] }
                },
                "required": ["id", "title", "status"]
              }
            }
          }
        },
        hint: "Your payload has keys: [" + keys.join(', ') + "]. " +
          "You must provide a '$defs' object containing your model definitions. " +
          "Each model needs: type='object', x-original-name, properties (with at least 'id'), and required array."
      }
    }
  }

  // Check $defs is an object
  if (typeof payload.$defs !== 'object' || Array.isArray(payload.$defs)) {
    return {
      valid: false,
      error: {
        code: "INVALID_DEFS",
        message: "'$defs' must be an object containing model definitions",
        received: Array.isArray(payload.$defs) ? 'array' : typeof payload.$defs,
        hint: "$defs should be { ModelName: { type: 'object', properties: {...} }, ... }"
      }
    }
  }

  const modelNames = Object.keys(payload.$defs)
  
  // Check $defs is not empty
  if (modelNames.length === 0) {
    return {
      valid: false,
      error: {
        code: "EMPTY_DEFS",
        message: "'$defs' is empty - at least one model is required",
        hint: "Add at least one model definition to $defs"
      }
    }
  }

  // Validate each model definition
  for (const modelName of modelNames) {
    const model = payload.$defs[modelName]
    
    if (!model || typeof model !== 'object') {
      return {
        valid: false,
        error: {
          code: "INVALID_MODEL",
          message: `Model '${modelName}' must be an object`,
          model: modelName,
          received: typeof model
        }
      }
    }

    if (model.type !== 'object') {
      return {
        valid: false,
        error: {
          code: "INVALID_MODEL_TYPE",
          message: `Model '${modelName}' must have type: 'object'`,
          model: modelName,
          received: model.type,
          hint: "Add \"type\": \"object\" to the model definition"
        }
      }
    }

    if (!model['x-original-name']) {
      return {
        valid: false,
        error: {
          code: "MISSING_ORIGINAL_NAME",
          message: `Model '${modelName}' is missing 'x-original-name' property`,
          model: modelName,
          hint: `Add "x-original-name": "${modelName}" to the model definition`
        }
      }
    }

    if (!model.properties || typeof model.properties !== 'object') {
      return {
        valid: false,
        error: {
          code: "MISSING_PROPERTIES",
          message: `Model '${modelName}' is missing 'properties' object`,
          model: modelName,
          hint: "Add a 'properties' object with field definitions. At minimum, include an 'id' field."
        }
      }
    }

    // Check for id field (required for MST)
    if (!model.properties.id) {
      return {
        valid: false,
        error: {
          code: "MISSING_ID_FIELD",
          message: `Model '${modelName}' is missing required 'id' property`,
          model: modelName,
          hint: "Add an 'id' field: { \"id\": { \"type\": \"string\", \"x-mst-type\": \"identifier\" } }"
        }
      }
    }
  }

  // Add standard schema properties if missing
  const enhanced = {
    "$schema": payload.$schema || "https://json-schema.org/draft/2020-12/schema",
    "$id": payload.$id || name,
    ...payload
  }

  return { valid: true, enhanced }
}

export function registerSchemaSet(server: FastMCP) {
  server.addTool({
    name: "schema.set",
    description: `Create or update a schema with Enhanced JSON Schema format.

REQUIRED FORMAT - Your payload MUST have this structure:
{
  "$defs": {
    "ModelName": {
      "type": "object",
      "x-original-name": "ModelName",
      "properties": {
        "id": { "type": "string", "x-mst-type": "identifier" },
        "fieldName": { "type": "string" }
      },
      "required": ["id", "fieldName"]
    }
  }
}

EXAMPLE - Todo app schema:
{
  "name": "todo-app",
  "payload": {
    "$defs": {
      "Category": {
        "type": "object",
        "x-original-name": "Category",
        "properties": {
          "id": { "type": "string", "x-mst-type": "identifier" },
          "name": { "type": "string" },
          "color": { "type": "string" }
        },
        "required": ["id", "name"]
      },
      "Task": {
        "type": "object",
        "x-original-name": "Task",
        "properties": {
          "id": { "type": "string", "x-mst-type": "identifier" },
          "title": { "type": "string" },
          "categoryId": { "type": "string" },
          "status": { "type": "string", "enum": ["pending", "in-progress", "done"] },
          "priority": { "type": "string", "enum": ["low", "medium", "high"] }
        },
        "required": ["id", "title", "status"]
      }
    }
  }
}

Field types: string, number, integer, boolean
Field formats: date, date-time, email, uri, uuid
Special: x-mst-type: "identifier" for the id field`,
    parameters: Params,
    execute: async (args: any) => {
      console.log('[schema.set] ========== SCHEMA.SET CALLED ==========')
      console.log('[schema.set] Args:', JSON.stringify(args, null, 2).slice(0, 1500))
      
      const { name, payload, schema, workspace, views, templates, options } = args as {
        name: string;
        payload?: any;
        schema?: string | object;
        workspace?: string;
        views?: Record<string, any>;
        templates?: Record<string, string>;
        options?: { validateReferences?: boolean }
      }

      // Resolve payload from either 'payload' or 'schema' parameter
      let resolvedPayload: any = payload
      if (!resolvedPayload && schema) {
        if (typeof schema === 'string') {
          try {
            resolvedPayload = JSON.parse(schema)
          } catch (parseError) {
            return JSON.stringify({ 
              ok: false, 
              error: { 
                code: "JSON_PARSE_ERROR", 
                message: `Failed to parse 'schema' string: ${parseError instanceof Error ? parseError.message : String(parseError)}` 
              } 
            })
          }
        } else {
          resolvedPayload = schema
        }
      }

      // Check if payload was provided
      if (!resolvedPayload) {
        return JSON.stringify({ 
          ok: false, 
          error: { 
            code: "MISSING_PAYLOAD", 
            message: "Either 'payload' or 'schema' parameter is required",
            hint: "Provide the schema definition in the 'payload' parameter"
          } 
        })
      }

      // If payload has $defs at the top level, use it directly
      // If payload has a nested structure (e.g., from op.data), extract the schema part
      let schemaPayload = resolvedPayload
      if (resolvedPayload.$defs) {
        schemaPayload = resolvedPayload
      } else if (resolvedPayload.schema && resolvedPayload.schema.$defs) {
        schemaPayload = resolvedPayload.schema
      } else if (resolvedPayload.payload && resolvedPayload.payload.$defs) {
        schemaPayload = resolvedPayload.payload
      }

      // Validate the schema
      const validation = validateEnhancedJsonSchema(schemaPayload, name)
      if (!validation.valid) {
        console.error('[schema.set] Validation failed:', validation.error)
        return JSON.stringify({ ok: false, error: validation.error })
      }

      const enhanced = validation.enhanced
      const effectiveWorkspace = getEffectiveWorkspace(workspace)

      try {
        // 1. Ingest into meta-store
        const metaStore = getMetaStore()
        const schemaEntity = metaStore.ingestEnhancedJsonSchema(enhanced, { name, ...(views && { views }) })

        // 2. Generate runtime MST store
        const enhancedWithMetadata = schemaEntity.toEnhancedJson
        const { createStore } = enhancedJsonSchemaToMST(enhancedWithMetadata, {
          generateActions: true,
          validateReferences: options?.validateReferences ?? false,
          enhanceCollections: (baseCollections) => {
            const result: Record<string, any> = {}
            for (const [collName, model] of Object.entries(baseCollections)) {
              result[collName] = types.compose(model, CollectionPersistable).named(collName)
            }
            return result
          }
        })

        // 3. Create environment with persistence
        const env: IEnvironment = {
          services: {
            persistence: new FileSystemPersistence()
          },
          context: {
            schemaName: schemaEntity.name,
            location: effectiveWorkspace
          }
        }

        // 4. Create and cache runtime store
        const runtimeStore = createStore(env)
        cacheRuntimeStore(schemaEntity.id, runtimeStore, effectiveWorkspace)

        // 5. Save schema to storage
        const savedPath = await saveSchema(schemaEntity, templates, effectiveWorkspace)

        // 6. Return success with schema info
        const models = schemaEntity.toModelDescriptors
        console.log('[schema.set] ✅ Schema created:', name, 'with', models.length, 'models')

        return JSON.stringify({
          ok: true,
          schemaId: schemaEntity.id,
          path: savedPath,
          models
        })

      } catch (error: any) {
        console.error('[schema.set] Ingestion error:', error)
        return JSON.stringify({
          ok: false,
          error: {
            code: "INGESTION_ERROR",
            message: error.message || "Failed to create schema",
            hint: "Check that all model definitions are valid and have proper field types"
          }
        })
      }
    },
  })
}
