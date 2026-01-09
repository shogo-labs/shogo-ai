/**
 * RequirementCard Component
 * Task: task-2-3b-002, task-discovery-view, task-sdr-v2-005
 *
 * Displays a requirement with all properties rendered via PropertyRenderer.
 * This is the vertical slice proving schema-driven rendering for entity cards.
 *
 * Props:
 * - requirement: Requirement object with id, name, description, priority, status
 *
 * Per design-2-3b-component-hierarchy:
 * - Built in /components/app/shared/ for reuse across phase views
 * - Uses PropertyRenderer for schema-driven rendering of all properties:
 *   - name: StringDisplay (type=string)
 *   - description: StringDisplay (type=string)
 *   - priority: PriorityBadge (enum with xRenderer=priority-badge)
 */

import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { PropertyRenderer, type PropertyMetadata } from "@/components/rendering"

/**
 * Priority type for requirement
 */
export type RequirementPriority = "must" | "should" | "could"

/**
 * Requirement type for card display
 */
export interface Requirement {
  id: string
  name: string
  description: string
  priority: RequirementPriority
  status: string
}

/**
 * Props for RequirementCard component
 */
export interface RequirementCardProps {
  /** Requirement to display */
  requirement: Requirement
}

/**
 * CVA variants for priority badge styling (legacy, kept for backward compatibility)
 * Maps requirement priority to visual styling
 * Pattern: must=red, should=amber, could=blue
 */
export const priorityBadgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      priority: {
        must: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
        should: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
        could: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      },
    },
    defaultVariants: {
      priority: "should",
    },
  }
)

/**
 * PropertyMetadata for name field - matches schema annotation
 */
const namePropertyMeta: PropertyMetadata = {
  name: "name",
  type: "string",
}

/**
 * PropertyMetadata for description field - matches schema annotation
 */
const descriptionPropertyMeta: PropertyMetadata = {
  name: "description",
  type: "string",
}

/**
 * PropertyMetadata for priority field - matches schema annotation
 */
const priorityPropertyMeta: PropertyMetadata = {
  name: "priority",
  type: "string",
  enum: ["must", "should", "could"],
  xRenderer: "priority-badge",
}

/**
 * RequirementCard Component
 *
 * Displays a single requirement with name, description, and priority badge.
 * Uses PropertyRenderer for schema-driven badge rendering.
 */
export function RequirementCard({ requirement }: RequirementCardProps) {
  return (
    <div
      data-testid={`requirement-card-${requirement.id}`}
      className={cn(
        "p-3 rounded-lg border bg-card",
        "hover:bg-accent/30 transition-colors"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-foreground truncate">
            <PropertyRenderer
              property={namePropertyMeta}
              value={requirement.name}
            />
          </h4>
          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
            <PropertyRenderer
              property={descriptionPropertyMeta}
              value={requirement.description}
            />
          </p>
        </div>
        <PropertyRenderer
          property={priorityPropertyMeta}
          value={requirement.priority}
        />
      </div>
    </div>
  )
}
