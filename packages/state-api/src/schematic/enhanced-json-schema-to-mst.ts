/**
 * Enhanced JSON Schema to MST Converter
 *
 * Simple, single-pass conversion leveraging MST's native composition features.
 * Uses types.compose() to cleanly separate concerns.
 *
 * Split into multiple files for esbuild/Sandpack compatibility:
 * - types.ts: Shared type definitions (MSTConversionOptions, MSTConversionResult)
 * - helpers-type-resolution.ts: Type resolution functions
 * - helpers-model-builder.ts: buildModel function
 * - helpers-store.ts: Collection and store factory functions
 */

import { types, type IAnyModelType } from "mobx-state-tree"
import { type EnhancedJsonSchema, type MSTConversionOptions, type MSTConversionResult } from "./types"
import { buildModel } from "./helpers-model-builder"
import { createCollectionModels, convertMultiDomainSchema } from "./helpers-store"

// Re-export types for backward compatibility
export type { MSTConversionOptions, MSTConversionResult }

/**
 * Converts enhanced JSON Schema to MST models and collections
 */
export function enhancedJsonSchemaToMST(
  schema: EnhancedJsonSchema,
  options: MSTConversionOptions = {}
): MSTConversionResult {
  let defs = schema.$defs || {}

  if (Object.keys(defs).length === 0 && schema.type === "object" && schema.properties) {
    const typeName = schema["x-original-name"] || "Model"
    defs = {
      [typeName]: {
        type: "object",
        properties: schema.properties,
        required: schema.required,
        "x-original-name": typeName,
        ...(schema["x-arktype"] && { "x-arktype": schema["x-arktype"] })
      }
    }
  }

  if (Object.keys(defs).length === 0) {
    throw new Error("Enhanced schema must have definitions or be a valid object type")
  }

  const isMultiDomain = Object.keys(defs).some(key => key.includes('.'))

  if (isMultiDomain) {
    return convertMultiDomainSchema(defs, options)
  }

  const entities = Object.entries(defs)
    .filter(([_, def]) => def["x-original-name"] && def.type === "object")
    .map(([_, def]) => ({
      name: def["x-original-name"] as string,
      schema: def
    }))

  let models: Record<string, IAnyModelType> = {}

  for (const { name, schema: entitySchema } of entities) {
    models[name] = buildModel(name, entitySchema, defs, models, options)
  }

  if (options.enhanceModels) {
    models = options.enhanceModels(models)
  }

  let collectionModels = createCollectionModels(models, defs)

  if (options.enhanceCollections) {
    collectionModels = options.enhanceCollections(collectionModels)
  }

  const rootProps: Record<string, any> = {}
  for (const [collectionName, collectionModel] of Object.entries(collectionModels)) {
    const propName = collectionName.charAt(0).toLowerCase() + collectionName.slice(1)
    rootProps[propName] = types.optional(collectionModel, { items: {} })
  }
  let RootStoreModel = types.model("RootStore", rootProps)

  if (options.enhanceRootStore) {
    RootStoreModel = options.enhanceRootStore(RootStoreModel)
  }

  const createStore = (environment?: any) => {
    return RootStoreModel.create({}, environment)
  }

  return {
    models,
    collectionModels,
    RootStoreModel,
    createStore
  }
}
