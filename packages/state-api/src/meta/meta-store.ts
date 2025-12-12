/**
 * Meta-Store: Enhanced MST models with layered computed views
 *
 * This module creates a meta-store with proper MST views and actions
 *
 * Architecture:
 * - Layer 1: Relationship views (cached queries: properties, children, etc.)
 * - Layer 2: Conversion views (compose Layer 1 into JSON Schema)
 * - Root actions: ingestEnhancedJsonSchema for state mutation
 *
 * Benefits:
 * - MobX caching/memoization of computed views
 * - Reactive updates propagate through view dependencies
 * - Clean API: schema.toEnhancedJson() vs passing parameters
 */

import { createStoreFromScope } from "../schematic/index"
import { MetaRegistry } from "./meta-registry"
import { createPropertyEnhancements } from "./meta-store-property-enhancements"
import { createModelEnhancements } from "./meta-store-model-enhancements"
import { createSchemaEnhancements } from "./meta-store-schema-enhancements"
import { createRootStoreEnhancements } from "./meta-store-root-enhancements"
import type { IPersistenceService } from "../persistence/types"

/**
 * Creates an enhanced meta-store with layered computed views.
 *
 * Uses enhancement hooks to add views and actions BEFORE store instantiation.
 * This is the proper MST lifecycle - enhance model definitions, THEN create instances.
 *
 * Enhancements:
 * - Property views: children navigation + toJsonSchema()
 * - Model views: properties lookup + toJsonSchema()
 * - Schema views: models lookup + toEnhancedJson()
 * - Store actions: ingestEnhancedJsonSchema(), loadSchema()
 *
 * **Persistence Injection:**
 * Persistence is now injected via MST environment instead of module-level state.
 * Pass it when calling createStore():
 * ```typescript
 * const { createStore } = createMetaStore()
 * const metaStore = createStore({ services: { persistence } })
 * ```
 *
 * @param _options - DEPRECATED. Pass persistence via environment instead.
 * @returns Enhanced store factory with models and createStore function
 */
export function createMetaStore() {
  return createStoreFromScope(MetaRegistry, {
    // HOOK 1: Enhance entity models with layered views
    enhanceModels: (baseModels) => ({
      ViewDefinition: baseModels.ViewDefinition,  // Pass through (no custom views needed)
      Property: createPropertyEnhancements(baseModels),
      Model: createModelEnhancements(baseModels),
      Schema: createSchemaEnhancements(baseModels)
    }),

    // HOOK 2: Enhance root store with actions
    enhanceRootStore: (RootModel) => createRootStoreEnhancements(RootModel)
  })
}
