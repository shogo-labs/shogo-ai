/**
 * Model Builder Helper for Enhanced JSON Schema to MST Conversion
 *
 * Contains the buildModel function that creates MST models from schema.
 * Split from enhanced-json-schema-to-mst.ts for esbuild compatibility.
 */

import {
  types,
  type IAnyModelType,
  getRoot
} from "mobx-state-tree"
import { extractTargetModel, resolvePropertyType } from "./helpers-type-resolution"
import type { MSTConversionOptions } from "./types"

// ============================================================================
// Collection Name Helper
// ============================================================================

/**
 * Converts an entity name to a collection property name.
 *
 * Preserves camelCase for multi-word entity names:
 * - "User" → "userCollection"
 * - "AuthUser" → "authUserCollection"
 * - "ProductCategory" → "productCategoryCollection"
 *
 * This matches the naming pattern in helpers-store.ts.
 */
function toCollectionPropName(entityName: string): string {
  const collectionName = `${entityName}Collection`
  return collectionName.charAt(0).toLowerCase() + collectionName.slice(1)
}

// ============================================================================
// Reference Creation Helper
// ============================================================================

/**
 * Creates an MST reference type with domain-aware collection lookup.
 *
 * This helper encapsulates the shared logic for both single and array references:
 * - Domain-aware collection resolution (e.g., "auth.User" → root.auth.userCollection)
 * - Optional reference validation on set
 * - ID extraction from value or string
 *
 * @param targetRef - The target model reference (e.g., "User" or "auth.User")
 * @param allModels - Map of all models for late binding
 * @param options - Conversion options (for validateReferences flag)
 * @returns MST reference type with custom get/set handlers
 */
function createMSTReference(
  targetRef: string,
  allModels: Record<string, IAnyModelType>,
  options: MSTConversionOptions
) {
  // Extract the model name (last part after any domain prefix)
  const modelName = targetRef.includes('.') ? targetRef.split('.').pop()! : targetRef

  return types.reference(
    types.late(() => allModels[targetRef] || allModels[modelName]),
    {
      get(identifier, parent) {
        const root = getRoot(parent) as any

        // Domain-aware lookup: "auth.User" → root.auth.authUserCollection
        if (targetRef.includes('.')) {
          const [domain, name] = targetRef.split('.')
          return root[domain]?.[toCollectionPropName(name)]?.get(identifier)
        }

        // Simple lookup: "User" → root.userCollection
        return root[toCollectionPropName(modelName)]?.get(identifier)
      },

      set(value, parent) {
        const id = typeof value === "string" ? value : value.id

        // Validate reference exists if option enabled
        if (options.validateReferences && id) {
          const root = getRoot(parent) as any

          if (targetRef.includes('.')) {
            const [domain, name] = targetRef.split('.')
            const collection = root[domain]?.[toCollectionPropName(name)]
            if (collection && !collection.has(id)) {
              throw new Error(`Reference to ${targetRef} with id "${id}" not found`)
            }
          } else {
            const collection = root[toCollectionPropName(modelName)]
            if (collection && !collection.has(id)) {
              throw new Error(`Reference to ${targetRef} with id "${id}" not found`)
            }
          }
        }

        return id
      }
    }
  )
}

// ============================================================================
// Model Builder
// ============================================================================

/**
 * Builds a single MST model using composition
 */
export function buildModel(
  name: string,
  entitySchema: any,
  allDefs: Record<string, any>,
  allModels: Record<string, IAnyModelType>,
  options: MSTConversionOptions
): IAnyModelType {
  const required = new Set(entitySchema.required || [])

  // Get arkType validator if scope is provided
  let arkTypeValidator = null

  if (options.arkTypeScope && entitySchema["x-original-name"]) {
    // Check if it's a single Scope or multi-domain scopes
    if (typeof options.arkTypeScope.export === "function") {
      // Single Scope
      arkTypeValidator = options.arkTypeScope.export()[entitySchema["x-original-name"]]
    } else if (entitySchema["x-domain"]) {
      // Multi-domain - find the right scope
      const domainScope = options.arkTypeScope[entitySchema["x-domain"]]
      if (domainScope && typeof domainScope.export === "function") {
        arkTypeValidator = domainScope.export()[entitySchema["x-original-name"]]
      }
    }
  }

  // Separate properties by type
  const dataProps: Record<string, any> = {}
  const refProps: Record<string, any> = {}
  const computedViews: Record<string, any> = {}
  const actions: Record<string, any> = {}

  for (const [propName, propSchema] of Object.entries(entitySchema.properties || {})) {
    // Skip computed properties - they'll be views
    if (propSchema["x-computed"]) {
      const targetModel = extractTargetModel(propSchema["x-arktype"])
      const targetRef = propSchema.items?.$ref?.replace("#/$defs/", "") || targetModel
      computedViews[propName] = {
        inverse: propSchema["x-inverse"],
        modelName: targetRef || targetModel
      }
      continue
    }

    // Check if this is an identifier field first (before checking references)
    if (propName === "id" || propName.toLowerCase() === "id" ||
      propSchema["x-mst-type"] === "identifier" ||
      (propSchema["x-arktype"] && propSchema["x-arktype"].includes("uuid"))) {
      const propType = resolvePropertyType(propName, propSchema, allDefs, new Set())
      dataProps[propName] = required.has(propName)
        ? propType
        : types.optional(propType, undefined)
      continue
    }

    // Handle references - only if explicitly marked as reference type
    if (propSchema["x-reference-type"] === "single") {
      const targetModel = extractTargetModel(propSchema["x-arktype"])
      const targetRef = propSchema.$ref?.replace("#/$defs/", "") || targetModel
      const refType = createMSTReference(targetRef, allModels, options)
      refProps[propName] = types.maybe(refType)

      const capitalizedName = propName.charAt(0).toUpperCase() + propName.slice(1)
      actions[`set${capitalizedName}`] = function (value: any) {
        ; (this as any)[propName] = value
      }
    } else if (propSchema["x-reference-type"] === "array") {
      const targetModel = extractTargetModel(propSchema["x-arktype"])
      const targetRef = propSchema.items?.$ref?.replace("#/$defs/", "") || targetModel
      const refType = createMSTReference(targetRef, allModels, options)
      refProps[propName] = types.optional(types.array(refType), [])
    } else {
      // Regular data property
      const propType = resolvePropertyType(propName, propSchema, allDefs, new Set())
      dataProps[propName] = required.has(propName)
        ? propType
        : types.maybe(propType)

      const capitalizedName = propName.charAt(0).toUpperCase() + propName.slice(1)
      actions[`set${capitalizedName}`] = function (value: any) {
        if (options.generateActions && arkTypeValidator) {
          const fieldValidator = arkTypeValidator.pick(propName)
          const result = fieldValidator({ [propName]: value })
          if ((result as any)[" arkKind"] === "errors") {
            const firstError = (result as any)[0]
            throw new Error(firstError.message)
          }
        }
        ; (this as any)[propName] = value
      }

      if (propSchema.type === "array" && !propSchema["x-reference-type"] && !propSchema["x-computed"]) {
        actions[`add${capitalizedName}Item`] = function (item: any) {
          ; (this as any)[propName].push(item)
        }
        actions[`remove${capitalizedName}Item`] = function (index: number) {
          ; (this as any)[propName].splice(index, 1)
        }
        actions[`update${capitalizedName}Item`] = function (index: number, value: any) {
          ; (this as any)[propName][index] = value
        }
        actions[`clear${capitalizedName}`] = function () {
          ; (this as any)[propName].clear()
        }
      }
    }
  }

  // Build composed model
  let model = types.model(name, dataProps)

  // Add preProcessSnapshot validation if arkType validator is available
  if (arkTypeValidator) {
    model = model.preProcessSnapshot((snapshot: any) => {
      const fieldsToValidate: string[] = []
      for (const [propName, propSchema] of Object.entries(entitySchema.properties || {})) {
        if (!propSchema["x-reference-type"] && !propSchema["x-computed"]) {
          fieldsToValidate.push(propName)
        }
      }
      if (fieldsToValidate.length > 0) {
        // Separate required from optional fields
        const requiredFields = fieldsToValidate.filter(f => required.has(f))
        const optionalFields = fieldsToValidate.filter(f => !required.has(f))

        // Always validate required fields (missing/undefined will correctly fail)
        if (requiredFields.length > 0) {
          const requiredValidator = arkTypeValidator.pick(...requiredFields)
          const result = requiredValidator(snapshot)
          if ((result as any)[" arkKind"] === "errors") {
            const firstError = (result as any)[0]
            throw new Error(`Validation failed: ${firstError.message}`)
          }
        }

        // Only validate optional fields that are actually present in snapshot
        // (undefined optional fields are valid - MST's types.maybe() handles them)
        const presentOptionalFields = optionalFields.filter(f => snapshot[f] !== undefined)
        if (presentOptionalFields.length > 0) {
          const optionalValidator = arkTypeValidator.pick(...presentOptionalFields)
          const optionalData = Object.fromEntries(
            presentOptionalFields.map(f => [f, snapshot[f]])
          )
          const result = optionalValidator(optionalData)
          if ((result as any)[" arkKind"] === "errors") {
            const firstError = (result as any)[0]
            throw new Error(`Validation failed: ${firstError.message}`)
          }
        }
      }
      return snapshot
    })
  }

  // Add references if any
  if (Object.keys(refProps).length > 0) {
    const refModel = types.model(refProps)
    model = types.compose(model, refModel)
  }

  // Add views if any
  if (Object.keys(computedViews).length > 0) {
    model = model.views(self => {
      const views: Record<string, any> = {}
      for (const [viewName, viewConfig] of Object.entries(computedViews)) {
        Object.defineProperty(views, viewName, {
          get() {
            const root = getRoot(self) as any
            let collection
            if (viewConfig.modelName.includes('.')) {
              const [domain, modelName] = viewConfig.modelName.split('.')
              collection = root[domain]?.[toCollectionPropName(modelName)]
            } else {
              collection = root[toCollectionPropName(viewConfig.modelName)]
            }
            if (!collection) return []
            return collection.all().filter((item: any) => {
              const ref = item[viewConfig.inverse]
              return ref === self || (ref && ref.id === self.id)
            })
          },
          enumerable: true,
          configurable: true
        })
      }
      return views
    })
  }

  // Add actions if any
  if (Object.keys(actions).length > 0) {
    model = model.actions(self => {
      const boundActions: Record<string, any> = {}
      for (const [actionName, actionFn] of Object.entries(actions)) {
        boundActions[actionName] = actionFn.bind(self)
      }
      return boundActions
    })
  }

  return model
}
