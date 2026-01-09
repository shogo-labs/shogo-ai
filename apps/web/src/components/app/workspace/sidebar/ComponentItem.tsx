/**
 * ComponentItem Component
 * Task: task-dcb-009
 *
 * Renders an individual component in the sidebar catalog with name, category badge,
 * and click handler. Follows the FeatureItem pattern for consistency.
 *
 * Props:
 * - component: ComponentDefinition object with id, name, category, description
 * - isSelected: Whether this item is currently selected
 * - onSelect: Callback when item is clicked (selection) - receives component id
 *
 * Per dynamic-component-builder-vision:
 * - Built fresh in /components/app/workspace/sidebar/
 * - Uses shadcn/ui components and Tailwind CSS
 * - Wrapped with observer() for MobX reactivity
 */

import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

/**
 * ComponentDefinition type for sidebar display
 * Matches the schema defined in component-builder
 */
export interface ComponentDefinition {
  id: string
  name: string
  category: "display" | "input" | "layout" | "visualization"
  description?: string
  implementationRef: string
  tags?: string[]
}

/**
 * Props for ComponentItem component
 */
export interface ComponentItemProps {
  /** Component definition to display */
  component: ComponentDefinition
  /** Whether this item is currently selected */
  isSelected: boolean
  /** Callback when item is clicked - receives component id */
  onSelect: (id: string) => void
}

/**
 * Category color CSS class mapping
 * Uses subtle background colors with matching text
 */
const CATEGORY_COLORS: Record<string, string> = {
  display: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  input: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  layout: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  visualization: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
}

/**
 * ComponentItem Component
 *
 * Renders a single component definition as a clickable row in the sidebar catalog.
 * Shows component name with category badge and description snippet.
 * Highlights when selected using bg-accent.
 */
export const ComponentItem = observer(function ComponentItem({
  component,
  isSelected,
  onSelect,
}: ComponentItemProps) {
  const categoryColor = CATEGORY_COLORS[component.category] ?? CATEGORY_COLORS.display

  return (
    <div
      className={cn(
        "component-item group w-full flex flex-col gap-0.5 rounded-md transition-colors",
        "hover:bg-accent/30",
        isSelected && "bg-accent"
      )}
      data-testid={`component-item-${component.id}`}
      data-selected={isSelected}
    >
      {/* Main clickable area for selection */}
      <button
        type="button"
        onClick={() => onSelect(component.id)}
        className="flex-1 flex flex-col gap-1 px-3 py-2 text-left min-w-0"
        aria-selected={isSelected}
      >
        {/* Top row: name and category badge */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="truncate flex-1 text-sm text-foreground"
            style={{ fontFamily: "var(--font-body)" }}
          >
            {component.name}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0 h-4 shrink-0 border-0",
              categoryColor
            )}
          >
            {component.category}
          </Badge>
        </div>

        {/* Description snippet - secondary line */}
        {component.description && (
          <span className="text-xs text-muted-foreground truncate line-clamp-1">
            {component.description}
          </span>
        )}
      </button>
    </div>
  )
})
