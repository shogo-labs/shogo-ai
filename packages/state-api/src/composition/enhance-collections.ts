/**
 * Shared Collection Enhancement Utility
 *
 * Builds collection enhancement function that:
 * 1. Composes CollectionPersistable (if enabled)
 * 2. Composes CollectionQueryable (if enabled)
 * 3. Applies user enhancements on top
 *
 * Shared by domain() and loadSchema() to eliminate duplication.
 */

import { types, type IAnyModelType } from "mobx-state-tree"
import { CollectionPersistable } from "./persistable"
import { CollectionQueryable } from "./queryable"
import type { DomainEnhancements } from "../domain/types"

/**
 * Build collection enhancement function.
 *
 * @param userEnhance - Optional user enhancement function from domain config
 * @param enablePersistence - Whether to compose CollectionPersistable (default: true)
 * @param enableQueryable - Whether to compose CollectionQueryable (default: true)
 * @returns Enhancement function, or undefined if nothing to enhance
 *
 * @example
 * // In domain()
 * const enhance = buildEnhanceCollections(config.enhancements?.collections, true, true)
 *
 * // In loadSchema()
 * const enhance = buildEnhanceCollections(registeredEnhancements?.collections)
 */
export function buildEnhanceCollections(
  userEnhance?: DomainEnhancements["collections"],
  enablePersistence: boolean = true,
  enableQueryable: boolean = true
): ((cols: Record<string, IAnyModelType>) => Record<string, IAnyModelType>) | undefined {
  // Early return if nothing to do
  if (!enablePersistence && !enableQueryable && !userEnhance) {
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

    // Step 3: Apply user enhancements on top
    if (userEnhance) {
      result = userEnhance(result)
    }

    return result
  }
}
