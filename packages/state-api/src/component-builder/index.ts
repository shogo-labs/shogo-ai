/**
 * Component Builder Module
 *
 * Isomorphic types and utilities for the dynamic component registry system.
 * This module can be used by both MCP (for entity hydration) and apps/web (for React rendering).
 *
 * Key exports:
 * - componentBuilderDomain: Domain composition with enhancement hooks
 * - PropertyMetadata: Property metadata for component resolution
 * - ComponentEntrySpec: Intermediate format (no React dependency)
 * - Entity type aliases: ComponentDefinitionEntity, RegistryEntity, BindingEntity
 * - createMatcherFromExpression: MongoDB-style match expressions
 */

// Domain exports (primary API)
export {
  ComponentBuilderDomain,
  componentBuilderDomain,
  createComponentBuilderStore,
} from "./domain"
export type {
  CreateComponentBuilderStoreOptions,
  SlotDefinition,
  SlotContentEntry,
  // ComponentSpec nested types (used by PlanPreviewSection)
  ComponentRequirement,
  LayoutDecision,
  DataBinding,
  InteractionPattern,
  ReuseOpportunity,
  ComponentSpecPreviewSummary,
} from "./domain"

// Types exports
export * from "./types"

// Config utilities
export { mergeRendererConfig } from "./config-utils"

// Match expression exports
export {
  createMatcherFromExpression,
  createJsInterpreter,
  type MatchExpression,
  type PropertyMatcher
} from "./match-expression"

// Hydration exports (deprecated - use registry.toEntrySpecs() instead)
// Kept for backward compatibility during migration
export {
  hydrateRegistry,
  collectBindingsWithInheritance,
  type HydrationResult,
  type HydrationStore
} from "./hydration"
