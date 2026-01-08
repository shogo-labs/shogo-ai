/**
 * FeatureItem Component
 * Task: task-2-2-005, task-delete-003-feature-item-menu
 *
 * Renders a clickable feature row with name and status badge.
 * Uses CVA for status badge variants per design-2-2-component-hierarchy.
 * Includes DropdownMenu with delete action.
 *
 * Props:
 * - feature: Feature object with id, name, status
 * - isSelected: Whether this item is currently selected
 * - onClick: Callback when item is clicked (selection)
 * - onDelete: Callback when delete is triggered from menu
 *
 * Per design-2-2-clean-break:
 * - Built fresh in /components/app/workspace/sidebar/
 * - Zero imports from /components/Studio/
 */

import { cva, type VariantProps } from "class-variance-authority"
import { MoreVertical, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

/**
 * Feature type for sidebar display
 */
export interface Feature {
  id: string
  name: string
  status: string
  intent?: string
}

/**
 * Props for FeatureItem component
 */
export interface FeatureItemProps {
  /** Feature to display */
  feature: Feature
  /** Whether this item is currently selected */
  isSelected: boolean
  /** Callback when item is clicked */
  onClick: () => void
  /** Callback when delete action is triggered */
  onDelete?: () => void
}

/**
 * CVA variants for status badge styling
 * Maps feature status to visual styling
 */
export const statusBadgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      status: {
        discovery: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
        analysis: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
        classification: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
        design: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
        spec: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
        testing: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
        implementation: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
        complete: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
      },
    },
    defaultVariants: {
      status: "discovery",
    },
  }
)

/**
 * Get display label for status
 */
function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    discovery: "Discovery",
    analysis: "Analysis",
    classification: "Classification",
    design: "Design",
    spec: "Spec",
    testing: "Testing",
    implementation: "Implementation",
    complete: "Complete",
  }
  return labels[status] || status
}

/**
 * FeatureItem Component
 *
 * Renders a single feature as a clickable row in the sidebar.
 * Shows feature name (truncated if too long) and status badge.
 * Highlights when selected using bg-accent.
 * Includes action menu with delete option.
 */
export function FeatureItem({ feature, isSelected, onClick, onDelete }: FeatureItemProps) {
  const statusKey = feature.status as VariantProps<typeof statusBadgeVariants>["status"]

  return (
    <div
      className={cn(
        "group w-full flex items-center gap-1 pr-1 rounded-md transition-colors",
        "hover:bg-accent/50",
        isSelected && "bg-accent"
      )}
      data-testid={`feature-item-${feature.id}`}
    >
      {/* Main clickable area for selection */}
      <button
        type="button"
        onClick={onClick}
        className="flex-1 flex items-center justify-between gap-2 px-3 py-2 text-left text-sm min-w-0"
        aria-selected={isSelected}
      >
        <span className="truncate flex-1 text-foreground">{feature.name}</span>
        <span className={statusBadgeVariants({ status: statusKey })}>
          {getStatusLabel(feature.status)}
        </span>
      </button>

      {/* Action menu - visible on hover or when selected */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0",
              isSelected && "opacity-100"
            )}
            onClick={(e) => e.stopPropagation()}
            aria-label="Feature actions"
          >
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            variant="destructive"
            onClick={onDelete}
            className="cursor-pointer"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
