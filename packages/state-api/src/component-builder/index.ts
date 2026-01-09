/**
 * Component Builder Module
 *
 * Isomorphic types and utilities for the dynamic component registry system.
 * This module can be used by both MCP (for entity hydration) and apps/web (for React rendering).
 *
 * Key exports:
 * - PropertyMetadata: Property metadata for component resolution
 * - ComponentEntrySpec: Intermediate format (no React dependency)
 * - Entity type aliases: ComponentDefinitionEntity, RegistryEntity, BindingEntity
 * - createMatcherFromExpression: MongoDB-style match expressions
 * - createJsInterpreter: Custom interpreter creation
 */

// Types exports
export * from "./types"

// Match expression exports
export {
  createMatcherFromExpression,
  createJsInterpreter,
  type MatchExpression,
  type PropertyMatcher
} from "./match-expression"

// Hydration exports
export {
  hydrateRegistry,
  collectBindingsWithInheritance,
  type HydrationResult,
  type HydrationStore
} from "./hydration"
