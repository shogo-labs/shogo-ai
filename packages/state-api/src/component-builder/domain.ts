/**
 * Component Builder Domain
 *
 * Uses the domain() composition API to define ComponentDefinition, Registry,
 * and RendererBinding entities with enhancement hooks for computed views
 * (toEntrySpec, toEntrySpecs, allBindings), collection queries (findByCategory),
 * and priority-based binding resolution.
 *
 * Enables self-describing component infrastructure where UI components,
 * registries, and bindings are Wavesmith entities that Claude can query
 * and modify via MCP.
 *
 * V1 scope: ComponentDefinition, Registry, RendererBinding
 * V2 deferred: LayoutTemplate, Composition
 */

import { scope } from "arktype"
import { getRoot } from "mobx-state-tree"
import { domain } from "../domain"
import { createMatcherFromExpression } from "./match-expression"
import type { ComponentEntrySpec, PropertyMetadata } from "./types"

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================

/**
 * Component Builder domain scope defining V1 entities.
 *
 * Note: Uses 'string' for id fields (not 'string.uuid') to match existing
 * seed data that uses custom id formats like 'comp-string', 'reg-default'.
 */
export const ComponentBuilderDomain = scope({
  ComponentDefinition: {
    id: "string",
    name: "string",
    category: "'display' | 'input' | 'layout' | 'visualization'",
    "description?": "string",
    implementationRef: "string",
    "previewRef?": "string",
    "tags?": "string[]",
    "propsSchema?": "unknown",
    createdAt: "number",
    "updatedAt?": "number",
  },

  Registry: {
    id: "string",
    name: "string",
    "description?": "string",
    "extends?": "Registry", // Maybe-reference to parent registry
    "fallbackComponent?": "ComponentDefinition", // Maybe-reference to fallback
    "bindings?": "RendererBinding[]", // Computed inverse
    createdAt: "number",
    "updatedAt?": "number",
  },

  RendererBinding: {
    id: "string",
    name: "string",
    registry: "Registry", // Required reference
    component: "ComponentDefinition", // Required reference
    matchExpression: "unknown", // MongoDB-style query object
    priority: "number",
    createdAt: "number",
    "updatedAt?": "number",
  },
})

// ============================================================
// 2. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Component Builder domain with all enhancements.
 * Registered in enhancement registry for meta-store integration.
 */
export const componentBuilderDomain = domain({
  name: "component-builder", // Must match schema name exactly
  from: ComponentBuilderDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,

      // RendererBinding computed views
      RendererBinding: models.RendererBinding.views((self: any) => ({
        /**
         * Get matcher function from matchExpression.
         * Uses createMatcherFromExpression with AST caching.
         */
        get matcher(): (meta: PropertyMetadata) => boolean {
          return createMatcherFromExpression(self.matchExpression)
        },

        /**
         * Convert binding to ComponentEntrySpec (isomorphic, no React).
         * This is the main hydration output format.
         */
        toEntrySpec(): ComponentEntrySpec {
          return {
            id: self.id,
            priority: self.priority,
            matcher: this.matcher,
            componentRef: self.component?.implementationRef ?? "FallbackDisplay",
          }
        },
      })),

      // Registry computed views
      Registry: models.Registry.views((self: any) => ({
        /**
         * Get all bindings including inherited from parent registries.
         * Child bindings appear before parent bindings (child-first priority).
         * Includes circular reference detection.
         */
        get allBindings(): any[] {
          const collectWithInheritance = (
            reg: any,
            visited: Set<string>
          ): any[] => {
            if (!reg || visited.has(reg.id)) return []
            visited.add(reg.id)

            // Collect own bindings (child-first)
            const own = Array.from(reg.bindings ?? [])

            // Recursively collect from parent
            const inherited = reg.extends
              ? collectWithInheritance(reg.extends, visited)
              : []

            return [...own, ...inherited]
          }

          return collectWithInheritance(self, new Set())
        },

        /**
         * Convert registry to ComponentEntrySpec[] for hydration.
         * Returns specs sorted by priority (highest first), with
         * child-first ordering preserved for equal priorities.
         */
        toEntrySpecs(): ComponentEntrySpec[] {
          return this.allBindings
            .sort((a: any, b: any) => b.priority - a.priority)
            .map((b: any) => b.toEntrySpec())
        },

        /**
         * Get fallback component implementationRef.
         * Traverses extends chain with child taking precedence.
         */
        get fallbackRef(): string | undefined {
          const resolveFallback = (reg: any, visited: Set<string>): string | undefined => {
            if (!reg || visited.has(reg.id)) return undefined
            visited.add(reg.id)

            // Check this registry first (child precedence)
            if (reg.fallbackComponent) {
              return reg.fallbackComponent.implementationRef
            }

            // Check parent
            return reg.extends ? resolveFallback(reg.extends, visited) : undefined
          }

          return resolveFallback(self, new Set())
        },
      })),
    }),

    // --------------------------------------------------------
    // collections: Add query methods (CollectionPersistable auto-composed)
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,

      ComponentDefinitionCollection: collections.ComponentDefinitionCollection.views(
        (self: any) => ({
          /**
           * Find all components in a given category.
           */
          findByCategory(
            category: "display" | "input" | "layout" | "visualization"
          ): any[] {
            return self.all().filter((c: any) => c.category === category)
          },

          /**
           * Find component by implementationRef.
           */
          findByImplementationRef(ref: string): any | undefined {
            return self.all().find((c: any) => c.implementationRef === ref)
          },

          /**
           * Find components by tag.
           */
          findByTag(tag: string): any[] {
            return self
              .all()
              .filter((c: any) => c.tags?.includes(tag))
          },
        })
      ),

      RegistryCollection: collections.RegistryCollection.views((self: any) => ({
        /**
         * Find registry by name.
         */
        findByName(name: string): any | undefined {
          return self.all().find((r: any) => r.name === name)
        },

        /**
         * Get the default registry (by convention: name === "Default Registry").
         */
        get defaultRegistry(): any | undefined {
          return self.all().find((r: any) => r.name === "Default Registry")
        },
      })),

      RendererBindingCollection: collections.RendererBindingCollection.views(
        (self: any) => ({
          /**
           * Find all bindings for a registry.
           */
          findByRegistry(registryId: string): any[] {
            return self.all().filter((b: any) => b.registry?.id === registryId)
          },

          /**
           * Find all bindings that use a specific component.
           */
          findByComponent(componentId: string): any[] {
            return self.all().filter((b: any) => b.component?.id === componentId)
          },
        })
      ),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain-level views and actions
    // --------------------------------------------------------
    rootStore: (RootModel) =>
      RootModel.views((self: any) => ({
        /**
         * Get the default registry with all bindings hydrated.
         */
        get defaultRegistrySpecs(): ComponentEntrySpec[] {
          const registry = self.registryCollection.defaultRegistry
          return registry ? registry.toEntrySpecs() : []
        },

        /**
         * Get total component count across all categories.
         */
        get componentCount(): number {
          return self.componentDefinitionCollection.all().length
        },

        /**
         * Get component counts by category.
         */
        get componentCountByCategory(): Record<string, number> {
          const counts: Record<string, number> = {
            display: 0,
            input: 0,
            layout: 0,
            visualization: 0,
          }
          for (const c of self.componentDefinitionCollection.all()) {
            if (c.category in counts) {
              counts[c.category]++
            }
          }
          return counts
        },
      })),
  },
})

// ============================================================
// 3. BACKWARD-COMPATIBLE STORE FACTORY
// ============================================================

export interface CreateComponentBuilderStoreOptions {
  /** Enable reference validation (default: true in dev) */
  validateReferences?: boolean
}

/**
 * Creates component builder store with backward-compatible API.
 */
export function createComponentBuilderStore(
  _options: CreateComponentBuilderStoreOptions = {}
) {
  return {
    createStore: componentBuilderDomain.createStore,
    RootStoreModel: componentBuilderDomain.RootStoreModel,
    domain: componentBuilderDomain,
  }
}
