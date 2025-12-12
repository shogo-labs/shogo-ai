/**
 * Domain Core Implementation
 *
 * The domain() function implementation that:
 * 1. Accepts ArkType Scope or Enhanced JSON Schema
 * 2. Applies enhancement hooks
 * 3. Auto-composes CollectionPersistable (unless disabled)
 * 4. Returns createStore() and register() methods
 */

import { types, type IAnyModelType, type IAnyStateTreeNode } from "mobx-state-tree"
import { arkTypeToEnhancedJsonSchema } from "../schematic/arktype-to-json-schema"
import { enhancedJsonSchemaToMST } from "../schematic/enhanced-json-schema-to-mst"
import type { EnhancedJsonSchema } from "../schematic/types"
import { CollectionPersistable } from "../composition/persistable"
import { registerEnhancements } from "./enhancement-registry"
import type { DomainConfig, DomainResult, DomainEnhancements } from "./types"
import { isScope, isEnhancedJsonSchema } from "./types"

/**
 * Create a domain from an ArkType Scope or Enhanced JSON Schema.
 *
 * @param config - Domain configuration
 * @returns DomainResult with createStore() and register() methods
 */
export function domain(config: DomainConfig): DomainResult {
  // Validate config
  if (!config.name || config.name.trim() === "") {
    throw new Error("domain() requires a non-empty name")
  }

  if (!isScope(config.from) && !isEnhancedJsonSchema(config.from)) {
    throw new Error(
      "domain() 'from' must be an ArkType Scope (has .export()) or Enhanced JSON Schema (has .$defs)"
    )
  }

  // Determine if persistence should be enabled (default: true)
  const enablePersistence = config.persistence !== false

  // Convert input to Enhanced JSON Schema (interchange format)
  let enhancedSchema: EnhancedJsonSchema
  let arkTypeScope: any = undefined

  if (isScope(config.from)) {
    // Code-first: Convert ArkType → Enhanced JSON Schema
    enhancedSchema = arkTypeToEnhancedJsonSchema(config.from)
    arkTypeScope = config.from

    // TODO: Merge metadata from .schemas/{name}/schema.json if exists
    // This will be implemented in metadata-merge.ts
  } else {
    // Schema-first: Use directly
    enhancedSchema = config.from
  }

  // Register enhancements if provided (for meta-store integration)
  if (config.enhancements) {
    registerEnhancements(config.name, config.enhancements)
  }

  // Build enhancement functions that include CollectionPersistable composition
  const buildEnhanceCollections = (
    userEnhance?: DomainEnhancements["collections"]
  ): ((cols: Record<string, IAnyModelType>) => Record<string, IAnyModelType>) | undefined => {
    if (!enablePersistence && !userEnhance) {
      return undefined
    }

    return (collections: Record<string, IAnyModelType>) => {
      let result = collections

      // Step 1: Auto-compose CollectionPersistable if enabled
      if (enablePersistence) {
        const withPersistence: Record<string, IAnyModelType> = {}
        for (const [name, model] of Object.entries(result)) {
          withPersistence[name] = types.compose(model, CollectionPersistable).named(name)
        }
        result = withPersistence
      }

      // Step 2: Apply user enhancements on top
      if (userEnhance) {
        result = userEnhance(result)
      }

      return result
    }
  }

  // Convert once and reuse - this is the canonical conversion result
  const conversionResult = enhancedJsonSchemaToMST(enhancedSchema, {
    generateActions: true,
    validateReferences: false,
    arkTypeScope,
    enhanceModels: config.enhancements?.models,
    enhanceCollections: buildEnhanceCollections(config.enhancements?.collections),
    enhanceRootStore: config.enhancements?.rootStore,
  })

  // Create the store factory (delegates to conversion result)
  const createStore = (env?: any): IAnyStateTreeNode => {
    return conversionResult.createStore(env)
  }

  // Create the register function for meta-store integration
  const register = (metaStore: any, options?: { workspace?: string }): any => {
    const workspace = options?.workspace

    // 1. Ingest schema into meta-store
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
      name: config.name,
      createdAt: Date.now(),
    })

    // 2. Create environment for store (persistence comes from caller context)
    const env = {
      services: {},
      context: {
        schemaName: config.name,
        location: workspace,
      },
    }

    // 3. Create runtime store (reuses conversionResult)
    const runtimeStore = conversionResult.createStore(env)

    // 4. Cache runtime store (supports workspace isolation)
    metaStore.cacheRuntimeStore(schema.id, runtimeStore, workspace)

    // 5. Return Schema entity
    return schema
  }

  return {
    name: config.name,
    enhancedSchema,
    RootStoreModel: conversionResult.RootStoreModel!,
    models: conversionResult.models,
    createStore,
    register,
  }
}
