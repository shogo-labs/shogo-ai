/**
 * Domain Core Implementation
 *
 * The domain() function implementation that:
 * 1. Accepts ArkType Scope or Enhanced JSON Schema
 * 2. Applies enhancement hooks
 * 3. Auto-composes CollectionPersistable (unless disabled)
 * 4. Returns createStore() and register() methods
 */

import { getEnv, type IAnyStateTreeNode } from "mobx-state-tree"
import { arkTypeToEnhancedJsonSchema } from "../schematic/arktype-to-json-schema"
import { enhancedJsonSchemaToMST } from "../schematic/enhanced-json-schema-to-mst"
import type { EnhancedJsonSchema } from "../schematic/types"
import { buildEnhanceCollections } from "../composition/enhance-collections"
import { registerEnhancements } from "./enhancement-registry"
import { getRuntimeStore, cacheRuntimeStore } from "../meta/runtime-store-cache"
import { computeColumnPropertyMaps, computePropertyTypeMaps } from "../ddl/utils"
import type { DomainConfig, DomainResult } from "./types"
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

  // Convert once and reuse - this is the canonical conversion result
  const conversionResult = enhancedJsonSchemaToMST(enhancedSchema, {
    generateActions: true,
    validateReferences: false,
    arkTypeScope,
    enhanceModels: config.enhancements?.models,
    enhanceCollections: buildEnhanceCollections(config.enhancements?.collections, enablePersistence),
    enhanceRootStore: config.enhancements?.rootStore,
  })

  // Pre-compute column property maps and property type maps for SQL backend support
  // This enables createStore() to work with SQL backends without meta-store registration
  const columnPropertyMaps = computeColumnPropertyMaps(enhancedSchema)
  const propertyTypeMaps = computePropertyTypeMaps(enhancedSchema)

  // Create the store factory (delegates to conversion result)
  const createStore = (env?: any): IAnyStateTreeNode => {
    // Inject pre-computed maps into env.context
    // This allows queryable.ts and mutatable.ts to pass them to registry.resolve()
    const enhancedEnv = env ? {
      ...env,
      context: {
        ...env.context,
        columnPropertyMaps,
        propertyTypeMaps,
      },
    } : undefined

    return conversionResult.createStore(enhancedEnv)
  }

  // Create the register function for meta-store integration
  const register = (metaStore: any, options?: { workspace?: string }): any => {
    const workspace = options?.workspace

    // FIX 1: Idempotency - check if schema already exists by name
    const existingSchema = metaStore.findSchemaByName?.(config.name)
    if (existingSchema) {
      // FIX 3: Check if runtime store is also cached
      const existingStore = getRuntimeStore(existingSchema.id, workspace)
      if (existingStore) {
        // Fully registered - return existing schema
        return existingSchema
      }
      // Schema exists but store not cached - fall through to create store
    }

    // Ingest schema (or reuse existing)
    const schema =
      existingSchema ||
      metaStore.ingestEnhancedJsonSchema(enhancedSchema, {
        name: config.name,
        createdAt: Date.now(),
      })

    // FIX 2: Get services from metaStore's environment (if it's an MST node)
    let persistence: any = undefined
    let backendRegistry: any = undefined
    try {
      const metaEnv = getEnv<any>(metaStore)
      persistence = metaEnv?.services?.persistence
      backendRegistry = metaEnv?.services?.backendRegistry
    } catch {
      // metaStore might not be an MST node in tests - that's ok
    }

    // Create environment with services from meta-store
    const env = {
      services: { persistence, backendRegistry },
      context: {
        schemaName: config.name,
        location: workspace,
      },
    }

    // Create runtime store (reuses conversionResult)
    const runtimeStore = conversionResult.createStore(env)

    // Cache runtime store (supports workspace isolation)
    cacheRuntimeStore(schema.id, runtimeStore, workspace)

    // Return Schema entity
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
