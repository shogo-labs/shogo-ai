/**
 * Enhancement Registry
 *
 * Module-level registry that stores domain enhancements by schema name.
 * This enables meta-store and MCP tools to retrieve and apply domain-specific
 * enhancements when loading schemas.
 */

import type { DomainEnhancements } from "./types"

/**
 * Module-level registry: Map<schemaName, DomainEnhancements>
 */
const enhancementRegistry = new Map<string, DomainEnhancements>()

/**
 * Register enhancements for a schema name.
 * Called internally by domain() when creating a domain.
 *
 * @param name - Schema name (unique identifier)
 * @param enhancements - The enhancement hooks
 */
export function registerEnhancements(name: string, enhancements: DomainEnhancements): void {
  enhancementRegistry.set(name, enhancements)
}

/**
 * Get enhancements for a schema by name.
 * Used by meta-store loadSchema() to apply domain-specific behavior.
 *
 * @param name - Schema name
 * @returns The enhancements if registered, undefined otherwise
 */
export function getEnhancements(name: string): DomainEnhancements | undefined {
  return enhancementRegistry.get(name)
}

/**
 * Check if enhancements are registered for a schema name.
 *
 * @param name - Schema name
 * @returns true if enhancements exist
 */
export function hasEnhancements(name: string): boolean {
  return enhancementRegistry.has(name)
}

/**
 * Clear all registered enhancements.
 * Used primarily for testing to reset state between tests.
 */
export function clearEnhancementRegistry(): void {
  enhancementRegistry.clear()
}

/**
 * Remove enhancements for a specific schema.
 *
 * @param name - Schema name to remove
 * @returns true if an entry was removed
 */
export function removeEnhancements(name: string): boolean {
  return enhancementRegistry.delete(name)
}
