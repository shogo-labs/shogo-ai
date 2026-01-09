/**
 * ComponentGroup Component
 * Task: task-dcb-010
 *
 * Renders a collapsible category section with components list.
 * Shows category header with expand/collapse chevron, component count badge,
 * and list of ComponentItems.
 *
 * Props:
 * - category: Category name to display ('display' | 'input' | 'layout' | 'visualization')
 * - components: Array of ComponentDefinition objects in this category
 * - selectedId: ID of currently selected component (optional)
 * - onSelect: Callback when a component is selected
 *
 * Per dynamic-component-builder-vision:
 * - Built fresh in /components/app/workspace/sidebar/
 * - Uses shadcn/ui components and Tailwind CSS
 * - Wrapped with observer() for MobX reactivity
 * - Follows FeatureGroup pattern for styling consistency
 */

import { useState, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { ComponentItem, type ComponentDefinition } from "./ComponentItem"

// ============================================================
// Constants
// ============================================================

/**
 * All 4 component categories in the component builder
 */
export const COMPONENT_CATEGORIES = [
  "display",
  "input",
  "layout",
  "visualization",
] as const

/**
 * Category type derived from COMPONENT_CATEGORIES constant
 */
export type ComponentCategory = (typeof COMPONENT_CATEGORIES)[number]

/**
 * Storage key prefix for collapse state persistence
 */
const STORAGE_KEY_PREFIX = "component-group-expanded-"

// ============================================================
// Local Storage Helpers
// ============================================================

function getStoredExpanded(category: string): boolean {
  if (typeof localStorage === "undefined") return true
  const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${category}`)
  // Default to expanded if no stored value
  return stored === null ? true : stored === "true"
}

function setStoredExpanded(category: string, expanded: boolean): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(`${STORAGE_KEY_PREFIX}${category}`, String(expanded))
}

// ============================================================
// Types
// ============================================================

/**
 * ComponentDefinition entity type from schema
 * Re-export from ComponentItem for convenience
 */
export type ComponentDefinitionEntity = ComponentDefinition

/**
 * Props for ComponentGroup component
 */
export interface ComponentGroupProps {
  /** Category name to display (e.g., "display", "input", "layout", "visualization") */
  category: string
  /** Components in this category */
  components: ComponentDefinitionEntity[]
  /** ID of currently selected component (optional) */
  selectedId?: string
  /** Callback when a component is selected */
  onSelect: (id: string) => void
}

/**
 * Display name mapping for categories
 * Converts lowercase category to title case for display
 */
const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  display: "Display",
  input: "Input",
  layout: "Layout",
  visualization: "Visualization",
}

// ============================================================
// Component
// ============================================================

/**
 * ComponentGroup Component
 *
 * Renders a collapsible section for a specific category with:
 * - Header showing category name, expand/collapse chevron, and count badge
 * - List of ComponentItems for each component in the category
 * - "No components" message when category is empty
 */
export const ComponentGroup = observer(function ComponentGroup({
  category,
  components,
  selectedId,
  onSelect,
}: ComponentGroupProps) {
  // Initialize state from localStorage
  const [isExpanded, setIsExpanded] = useState(() => getStoredExpanded(category))

  // Toggle expand/collapse state and persist to localStorage
  const handleToggle = useCallback(() => {
    const newExpanded = !isExpanded
    setIsExpanded(newExpanded)
    setStoredExpanded(category, newExpanded)
  }, [isExpanded, category])

  // Get display name for category
  const displayName = CATEGORY_DISPLAY_NAMES[category] || category

  return (
    <div className={cn("mb-4")} data-testid={`component-group-${category.toLowerCase()}`}>
      {/* Category header with count badge and expand/collapse chevron */}
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          "flex items-center justify-between w-full px-3 py-2",
          "hover:bg-accent/30 rounded-md transition-colors"
        )}
      >
        <div className="flex items-center gap-1.5">
          {/* Expand/collapse chevron */}
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <h3
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {displayName}
          </h3>
        </div>
        <Badge
          variant="secondary"
          className="text-[10px] tracking-wider"
          style={{ fontFamily: "var(--font-micro)" }}
        >
          {components.length}
        </Badge>
      </button>

      {/* Collapsible content area */}
      {isExpanded && (
        <div className="mt-1 space-y-1 transition-all duration-200 ease-in-out">
          {/* Empty state message */}
          {components.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground italic">
              No components
            </div>
          ) : (
            /* Component items */
            components.map((component) => (
              <ComponentItem
                key={component.id}
                component={component}
                isSelected={component.id === selectedId}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
})
