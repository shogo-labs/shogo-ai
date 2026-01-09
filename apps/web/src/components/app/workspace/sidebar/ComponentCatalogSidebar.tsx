/**
 * ComponentCatalogSidebar Component
 * Task: task-dcb-011
 *
 * Main sidebar section for component catalog. Groups components by category
 * with search/filter functionality. Follows FeatureSidebar layout and styling patterns.
 *
 * Layout (flex-col):
 * - Header with "Components" title and total count
 * - SidebarSearch in middle
 * - ComponentGroups in scrollable content area
 *
 * Props:
 * - components: All ComponentDefinition entities to display
 * - selectedId: Currently selected component ID (optional)
 * - onSelect: Callback when a component is selected
 *
 * Per dynamic-component-builder-vision:
 * - Built fresh in /components/app/workspace/sidebar/
 * - Uses shadcn/ui components and Tailwind CSS
 * - Wrapped with observer() for MobX reactivity
 * - Follows FeatureSidebar pattern for styling consistency
 */

import { useState, useMemo } from "react"
import { observer } from "mobx-react-lite"
import { SidebarSearch } from "./SidebarSearch"
import { ComponentGroup, COMPONENT_CATEGORIES } from "./ComponentGroup"
import type { ComponentDefinition } from "./ComponentItem"

// ============================================================
// Types
// ============================================================

/**
 * Props for ComponentCatalogSidebar component
 */
export interface ComponentCatalogSidebarProps {
  /** All ComponentDefinition entities to display */
  components: ComponentDefinition[]
  /** Currently selected component ID (optional) */
  selectedId?: string
  /** Callback when a component is selected */
  onSelect: (id: string) => void
}

// ============================================================
// Filter Function
// ============================================================

/**
 * Filter components by search query.
 * Matches against component name and description (case-insensitive).
 *
 * @param components - Array of ComponentDefinition to filter
 * @param query - Search query string
 * @returns Filtered array of ComponentDefinition
 */
function filterComponents(
  components: ComponentDefinition[],
  query: string
): ComponentDefinition[] {
  if (!query.trim()) {
    return components
  }

  const lowerQuery = query.toLowerCase()

  return components.filter((component) => {
    const nameMatch = component.name.toLowerCase().includes(lowerQuery)
    const descriptionMatch = component.description?.toLowerCase().includes(lowerQuery) ?? false
    return nameMatch || descriptionMatch
  })
}

/**
 * Get components for a specific category
 *
 * @param components - Array of ComponentDefinition to filter
 * @param category - Category to filter by
 * @returns Components matching the category
 */
function getComponentsForCategory(
  components: ComponentDefinition[],
  category: string
): ComponentDefinition[] {
  return components.filter((c) => c.category === category)
}

// ============================================================
// Component
// ============================================================

/**
 * ComponentCatalogSidebar Component
 *
 * Renders the component catalog sidebar with:
 * - Header showing "Components" title and total count
 * - Search input for filtering
 * - ComponentGroups for each category in scrollable content area
 * - Empty state message when search yields no results
 *
 * Manages local searchQuery state for filtering components.
 */
export const ComponentCatalogSidebar = observer(function ComponentCatalogSidebar({
  components,
  selectedId,
  onSelect,
}: ComponentCatalogSidebarProps) {
  // Local state for search query
  const [searchQuery, setSearchQuery] = useState("")

  // Filter components by search query using useMemo for performance
  const filteredComponents = useMemo(() => {
    return filterComponents(components, searchQuery)
  }, [components, searchQuery])

  // Check if search yields no results
  const hasNoResults = searchQuery.trim() && filteredComponents.length === 0

  return (
    <div
      className="flex flex-col h-full"
      data-testid="component-catalog-sidebar"
    >
      {/* Header with title and count */}
      <header className="px-3 py-2 border-b border-border">
        <h2
          className="text-sm font-semibold text-foreground"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Components ({components.length})
        </h2>
      </header>

      {/* Search input */}
      <div className="p-3 border-b border-border">
        <SidebarSearch
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search components..."
        />
      </div>

      {/* Component groups in scrollable content area */}
      <div className="flex-1 overflow-y-auto py-2">
        {COMPONENT_CATEGORIES.map((category) => {
          const categoryComponents = getComponentsForCategory(filteredComponents, category)

          return (
            <ComponentGroup
              key={category}
              category={category}
              components={categoryComponents}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          )
        })}

        {/* Show message when no components match search */}
        {hasNoResults && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No components match "{searchQuery}"
          </div>
        )}
      </div>
    </div>
  )
})
