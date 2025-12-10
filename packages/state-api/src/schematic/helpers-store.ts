/**
 * Store Helpers for Enhanced JSON Schema to MST Conversion
 *
 * Contains collection and store factory functions.
 * Split from enhanced-json-schema-to-mst.ts for esbuild compatibility.
 */

import { types, type IAnyModelType } from "mobx-state-tree"
import { buildModel } from "./helpers-model-builder"
import { extractPersistenceConfig } from "../persistence/helpers"
import type { MSTConversionOptions, MSTConversionResult } from "./types"
import type { PersistenceConfig } from "../persistence/types"

/**
 * Creates collection models with xCollection naming.
 * Captures persistenceConfig from schema definitions in closure.
 *
 * @param models - Map of model names to MST models
 * @param modelDefs - Optional schema $defs for extracting x-persistence config
 */
export function createCollectionModels(
  models: Record<string, IAnyModelType>,
  modelDefs?: Record<string, any>
): Record<string, IAnyModelType> {
  const collections: Record<string, IAnyModelType> = {}

  for (const [modelName, model] of Object.entries(models)) {
    const collectionName = `${modelName}Collection`

    // Extract persistence config from schema definition (closure captures it)
    const persistenceConfig: PersistenceConfig = modelDefs?.[modelName]
      ? extractPersistenceConfig(modelDefs[modelName])
      : { strategy: 'flat' }

    // Capture all schema defs for nested persistence (needs to find parent references)
    const allDefs = modelDefs

    collections[collectionName] = types
      .model(collectionName, {
        items: types.map(model)
      })
      .views(self => ({
        get modelName() {
          return modelName
        },
        get persistenceConfigMetadata(): PersistenceConfig {
          return persistenceConfig
        },
        get schemaDefsMetadata(): Record<string, any> | undefined {
          return allDefs
        },
        get(id: string) {
          return self.items.get(id)
        },
        has(id: string) {
          return self.items.has(id)
        },
        all() {
          return Array.from(self.items.values())
        },
        findById(id: string) {
          return self.items.get(id)
        },
        findBy(field: string, value: any) {
          return Array.from(self.items.values()).filter(item => {
            const itemVal = item[field]
            // Direct equality (scalars)
            if (itemVal === value) return true
            // Reference comparison: resolved ref has .id property
            if (itemVal && typeof itemVal === 'object' && 'id' in itemVal) {
              return itemVal.id === value
            }
            return false
          })
        },
        where(filter: Record<string, any>) {
          return Array.from(self.items.values()).filter(item =>
            Object.entries(filter).every(([key, val]) => {
              const itemVal = item[key]
              // Direct equality (scalars)
              if (itemVal === val) return true
              // Reference comparison: resolved ref has .id property
              if (itemVal && typeof itemVal === 'object' && 'id' in itemVal) {
                return itemVal.id === val
              }
              return false
            })
          )
        }
      }))
      .actions(self => ({
        add(item: any) {
          const instance = model.create(item)
          self.items.put(instance)
          return instance
        },
        remove(id: string) {
          self.items.delete(id)
        },
        clear() {
          self.items.clear()
        }
      }))
  }

  return collections
}

/**
 * Creates the root store factory
 */
export function createStoreFactory(
  collectionModels: Record<string, IAnyModelType>
): (environment?: any) => any {
  const rootProps: Record<string, any> = {}

  for (const [collectionName, collectionModel] of Object.entries(collectionModels)) {
    const propName = collectionName.charAt(0).toLowerCase() + collectionName.slice(1)
    rootProps[propName] = types.optional(collectionModel, { items: {} })
  }

  const RootStore = types.model("RootStore", rootProps)

  return (environment?: any) => {
    return RootStore.create({}, environment)
  }
}

/**
 * Creates a multi-domain store factory
 */
export function createMultiDomainStoreFactory(
  domains: Record<string, MSTConversionResult>,
  options: MSTConversionOptions
): { RootStoreModel: IAnyModelType; createStore: (environment?: any) => any } {
  const domainStoreModels: Record<string, IAnyModelType> = {}

  for (const [domainName, domainResult] of Object.entries(domains)) {
    const domainProps: Record<string, any> = {}

    for (const [collectionName, collectionModel] of Object.entries(domainResult.collectionModels)) {
      const propName = collectionName.charAt(0).toLowerCase() + collectionName.slice(1)
      domainProps[propName] = types.optional(collectionModel, { items: {} })
    }

    const DomainStore = types.model(`${domainName}Store`, domainProps)
    domainStoreModels[domainName] = DomainStore
  }

  const rootProps: Record<string, any> = {}
  for (const [domainName, domainStore] of Object.entries(domainStoreModels)) {
    rootProps[domainName] = types.optional(domainStore, {})
  }

  let RootStoreModel = types.model("RootStore", rootProps)

  if (options.enhanceRootStore) {
    RootStoreModel = options.enhanceRootStore(RootStoreModel)
  }

  const createStore = (environment?: any) => {
    return RootStoreModel.create({}, environment)
  }

  return {
    RootStoreModel,
    createStore
  }
}

/**
 * Converts multi-domain schema to MST
 */
export function convertMultiDomainSchema(
  defs: Record<string, any>,
  options: MSTConversionOptions
): MSTConversionResult {
  const domainGroups: Record<string, Record<string, any>> = {}
  const allModels: Record<string, IAnyModelType> = {}

  for (const [key, def] of Object.entries(defs)) {
    if (key.includes('.')) {
      const [domain, entityName] = key.split('.')
      if (!domainGroups[domain]) {
        domainGroups[domain] = {}
      }
      domainGroups[domain][entityName] = {
        ...def,
        "x-original-name": entityName
      }
    }
  }

  for (const [key, def] of Object.entries(defs)) {
    if (def["x-original-name"] && def.type === "object") {
      const name = key.includes('.') ? key : def["x-original-name"]
      const modelName = def["x-original-name"]
      allModels[name] = buildModel(modelName, def, defs, allModels, options)
    }
  }

  const domains: Record<string, MSTConversionResult> = {}

  for (const [domainName, domainDefs] of Object.entries(domainGroups)) {
    const domainModels: Record<string, IAnyModelType> = {}
    for (const [entityName, def] of Object.entries(domainDefs)) {
      const fullName = `${domainName}.${entityName}`
      if (allModels[fullName]) {
        domainModels[entityName] = allModels[fullName]
      }
    }

    const domainCollectionModels = createCollectionModels(domainModels)
    const domainCreateStore = createStoreFactory(domainCollectionModels)

    domains[domainName] = {
      models: domainModels,
      collectionModels: domainCollectionModels,
      createStore: domainCreateStore
    }
  }

  const { RootStoreModel, createStore } = createMultiDomainStoreFactory(domains, options)

  return {
    models: allModels,
    collectionModels: {},
    RootStoreModel,
    createStore,
    domains
  }
}
