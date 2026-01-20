/**
 * Shared Collection Enhancement Utility
 *
 * Builds collection enhancement function that:
 * 1. Composes CollectionPersistable (if enabled)
 * 2. Composes CollectionQueryable (if enabled)
 * 3. Composes CollectionMutatable (if enabled)
 * 4. Applies user enhancements on top
 *
 * Shared by domain() and loadSchema() to eliminate duplication.
 */

import { types, type IAnyModelType } from "mobx-state-tree"
import { CollectionPersistable } from "./persistable"
import { CollectionQueryable } from "./queryable"
import { CollectionAuthorizable } from "./authorizable"
import { CollectionMutatable } from "./mutatable"
import type { DomainEnhancements } from "../domain/types"

/**
 * Build collection enhancement function.
 *
 * @param userEnhance - Optional user enhancement function from domain config
 * @param enablePersistence - Whether to compose CollectionPersistable (default: true)
 * @param enableQueryable - Whether to compose CollectionQueryable (default: true)
 * @param enableAuthorizable - Whether to compose CollectionAuthorizable (default: true)
 * @param enableMutatable - Whether to compose CollectionMutatable (default: true)
 * @returns Enhancement function, or undefined if nothing to enhance
 *
 * @remarks
 * Composition order is important:
 * 1. CollectionPersistable - Basic persistence capabilities
 * 2. CollectionQueryable - Provides query() method
 * 3. CollectionAuthorizable - Wraps query() with auth filter (requires Queryable)
 * 4. CollectionMutatable - Mutation operations
 * 5. User Enhancements - Custom domain logic
 *
 * CollectionAuthorizable MUST come after CollectionQueryable because it wraps query().
 *
 * @example
 * // In domain()
 * const enhance = buildEnhanceCollections(config.enhancements?.collections, true, true, true, true)
 *
 * // In loadSchema()
 * const enhance = buildEnhanceCollections(registeredEnhancements?.collections)
 */
export function buildEnhanceCollections(
  userEnhance?: DomainEnhancements["collections"],
  enablePersistence: boolean = true,
  enableQueryable: boolean = true,
  enableAuthorizable: boolean = true,
  enableMutatable: boolean = true
): ((cols: Record<string, IAnyModelType>) => Record<string, IAnyModelType>) | undefined {
  // Early return if nothing to do
  if (!enablePersistence && !enableQueryable && !enableAuthorizable && !enableMutatable && !userEnhance) {
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

    // Step 2: Auto-compose CollectionQueryable if enabled
    if (enableQueryable) {
      const withQueryable: Record<string, IAnyModelType> = {}
      for (const [name, model] of Object.entries(result)) {
        withQueryable[name] = types.compose(model, CollectionQueryable).named(name)
      }
      result = withQueryable
    }

    // Step 3: Auto-compose CollectionAuthorizable if enabled
    // Must come AFTER CollectionQueryable (wraps query() method)
    if (enableAuthorizable && enableQueryable) {
      const withAuthorizable: Record<string, IAnyModelType> = {}
      for (const [name, model] of Object.entries(result)) {
        withAuthorizable[name] = types.compose(model, CollectionAuthorizable).named(name)
      }
      result = withAuthorizable
    }

    // Step 4: Auto-compose CollectionMutatable if enabled
    if (enableMutatable) {
      const withMutatable: Record<string, IAnyModelType> = {}
      for (const [name, model] of Object.entries(result)) {
        withMutatable[name] = types.compose(model, CollectionMutatable).named(name)
      }
      result = withMutatable
    }

    // Step 5: Apply user enhancements on top
    if (userEnhance) {
      result = userEnhance(result)
    }

    return result
  }
}
