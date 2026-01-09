/**
 * ComponentRegistry - Priority-based cascade resolution for display components
 *
 * Resolves PropertyMetadata to display components using cascade priority:
 * 1. xRenderer explicit (200) - check registry by id
 * 2. xComputed (100) - ComputedDisplay
 * 3. xReferenceType (100) - ReferenceDisplay / ReferenceArrayDisplay
 * 4. enum (50) - EnumBadge
 * 5. format (30) - DateTimeDisplay, EmailDisplay, UriDisplay
 * 6. type (10) - StringDisplay, NumberDisplay, BooleanDisplay, etc.
 * 7. fallback (0) - StringDisplay
 *
 * Follows BackendRegistry pattern from packages/state-api/src/query/registry.ts
 *
 * Task: task-component-registry
 */

import type { ComponentType } from "react"
import type {
  PropertyMetadata,
  ComponentEntry,
  DisplayRendererProps,
  IComponentRegistry
} from "./types"

/**
 * Configuration for createComponentRegistry factory
 */
export interface ComponentRegistryConfig {
  /** Default component used when no entry matches */
  defaultComponent: ComponentType<DisplayRendererProps>
  /** Initial entries to register */
  entries?: ComponentEntry[]
}

/**
 * ComponentRegistry class implementing priority-based cascade resolution
 */
export class ComponentRegistry implements IComponentRegistry {
  private entries_: ComponentEntry[] = []
  private defaultComponent: ComponentType<DisplayRendererProps>

  constructor(defaultComponent: ComponentType<DisplayRendererProps>) {
    this.defaultComponent = defaultComponent
  }

  /**
   * Register a new component entry.
   * Entries are stored and sorted by priority (highest first).
   */
  register(entry: ComponentEntry): void {
    this.entries_.push({
      ...entry,
      priority: entry.priority ?? 10 // Default priority
    })
    // Sort by priority descending (highest first)
    this.entries_.sort((a, b) => (b.priority ?? 10) - (a.priority ?? 10))
  }

  /**
   * Remove a component entry by id.
   * @returns true if entry was found and removed, false otherwise
   */
  unregister(id: string): boolean {
    const index = this.entries_.findIndex((e) => e.id === id)
    if (index === -1) return false
    this.entries_.splice(index, 1)
    return true
  }

  /**
   * Get the best matching entry for property metadata.
   *
   * Iterates through entries sorted by priority (highest first).
   * Returns the first entry whose matches() predicate returns true.
   * Returns undefined if no entry matches (caller should use defaultComponent).
   *
   * This is useful when you need access to the entry's defaultConfig
   * or other metadata, not just the component.
   */
  getEntry(property: PropertyMetadata): ComponentEntry | undefined {
    for (const entry of this.entries_) {
      if (entry.matches(property)) {
        return entry
      }
    }
    return undefined
  }

  /**
   * Resolve property metadata to the best matching component.
   *
   * Iterates through entries sorted by priority (highest first).
   * Returns the first entry whose matches() predicate returns true.
   * Falls back to defaultComponent if no entry matches.
   */
  resolve(property: PropertyMetadata): ComponentType<DisplayRendererProps> {
    const entry = this.getEntry(property)
    return entry?.component ?? this.defaultComponent
  }

  /**
   * Get all registered entries (sorted by priority)
   */
  entries(): ComponentEntry[] {
    return [...this.entries_]
  }
}

/**
 * Factory function to create a configured ComponentRegistry
 */
export function createComponentRegistry(
  config: ComponentRegistryConfig
): ComponentRegistry {
  const registry = new ComponentRegistry(config.defaultComponent)

  if (config.entries) {
    for (const entry of config.entries) {
      registry.register(entry)
    }
  }

  return registry
}
