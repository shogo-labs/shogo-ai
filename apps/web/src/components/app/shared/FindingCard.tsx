/**
 * FindingCard Component
 * Task: task-2-3b-003, task-cbe-005
 *
 * Displays an analysis finding with type badge using PropertyRenderer.
 * All fields (type, description, location, recommendation) use PropertyRenderer
 * for schema-driven rendering.
 *
 * Props:
 * - finding: AnalysisFinding object with id, name, type, description, location, recommendation
 *
 * Per design-2-3b-component-hierarchy:
 * - Built in /components/app/shared/ for reuse across phase views
 * - Uses PropertyRenderer for schema-driven rendering of all properties:
 *   - type: FindingTypeBadge (xRenderer='finding-type-badge')
 *   - description: LongTextDisplay (xRenderer='long-text')
 *   - location: CodePathDisplay (xRenderer='code-path')
 *   - recommendation: LongTextDisplay (xRenderer='long-text')
 */

import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { PropertyRenderer, type PropertyMetadata } from "@/components/rendering"

/**
 * Finding type enum - matches AnalysisFinding entity
 */
export type FindingType =
  | "pattern"
  | "gap"
  | "risk"
  | "classification_evidence"
  | "integration_point"
  | "verification"
  | "existing_test"

/**
 * Finding type for card display
 */
export interface Finding {
  id: string
  name: string
  type: FindingType
  description: string
  location: string
  recommendation?: string
  relevantCode?: string
}

/**
 * Props for FindingCard component
 */
export interface FindingCardProps {
  /** Finding to display */
  finding: Finding
}

/**
 * CVA variants for finding type badge styling
 * Maps finding type to visual styling
 */
export const findingTypeBadgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      type: {
        pattern: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
        gap: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
        risk: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
        classification_evidence: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
        integration_point: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400",
        verification: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
        existing_test: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400",
      },
    },
    defaultVariants: {
      type: "pattern",
    },
  }
)

/**
 * Get display label for finding type (converts snake_case to Title Case)
 */
function getTypeLabel(type: FindingType): string {
  return type.split("_").map(word =>
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(" ")
}

/**
 * PropertyMetadata for description field - uses LongTextDisplay
 */
const descriptionPropertyMeta: PropertyMetadata = {
  name: "description",
  type: "string",
  xRenderer: "long-text",
}

/**
 * PropertyMetadata for location field - uses CodePathDisplay
 */
const locationPropertyMeta: PropertyMetadata = {
  name: "location",
  type: "string",
  xRenderer: "code-path",
}

/**
 * PropertyMetadata for recommendation field - uses LongTextDisplay
 */
const recommendationPropertyMeta: PropertyMetadata = {
  name: "recommendation",
  type: "string",
  xRenderer: "long-text",
}

/**
 * PropertyMetadata for type field - uses FindingTypeBadge
 */
const typePropertyMeta: PropertyMetadata = {
  name: "type",
  type: "string",
  xRenderer: "finding-type-badge",
}

/**
 * FindingCard Component
 *
 * Displays a single finding with name, type badge, description, location, and optional recommendation.
 * Uses PropertyRenderer for schema-driven rendering of all properties.
 */
export function FindingCard({ finding }: FindingCardProps) {
  return (
    <div
      data-testid={`finding-card-${finding.id}`}
      className={cn(
        "p-3 rounded-lg border bg-card",
        "hover:bg-accent/30 transition-colors"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-foreground truncate">
            {finding.name}
          </h4>
          {/* Use PropertyRenderer for description - LongTextDisplay with expand/collapse */}
          <div className="text-sm text-muted-foreground mt-1">
            <PropertyRenderer
              value={finding.description}
              property={descriptionPropertyMeta}
            />
          </div>
          {/* Use PropertyRenderer for location - CodePathDisplay with monospace + copy */}
          <div className="mt-2">
            <PropertyRenderer
              value={finding.location}
              property={locationPropertyMeta}
            />
          </div>
        </div>
        {/* Use PropertyRenderer for finding type badge */}
        <PropertyRenderer
          value={finding.type}
          property={typePropertyMeta}
        />
      </div>

      {finding.recommendation && (
        <div className="mt-3 pt-3 border-t">
          {/* Use PropertyRenderer for recommendation - LongTextDisplay */}
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Recommendation: </span>
            <PropertyRenderer
              value={finding.recommendation}
              property={recommendationPropertyMeta}
            />
          </div>
        </div>
      )}
    </div>
  )
}
