/**
 * ArchetypeBadge Component
 * Task: task-2-3b-004
 *
 * Displays a feature archetype badge with CVA variants.
 *
 * Props:
 * - archetype: Feature archetype ('domain' | 'service' | 'infrastructure' | 'hybrid')
 * - size: Optional size variant ('sm' | 'md')
 *
 * Per design-2-3b-component-hierarchy:
 * - Built in /components/app/shared/ for reuse across phase views
 * - CVA pattern matching FeatureItem.statusBadgeVariants
 */

import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * Archetype type for badge display
 */
export type FeatureArchetype = "domain" | "service" | "infrastructure" | "hybrid"

/**
 * Props for ArchetypeBadge component
 */
export interface ArchetypeBadgeProps {
  /** Feature archetype to display */
  archetype: FeatureArchetype
  /** Size variant */
  size?: "sm" | "md" | "lg"
}

/**
 * CVA variants for archetype badge styling
 * Maps archetype to visual styling
 * Pattern: domain=blue, service=purple, infrastructure=green, hybrid=amber
 */
export const archetypeBadgeVariants = cva(
  "inline-flex items-center rounded-full font-medium",
  {
    variants: {
      archetype: {
        domain: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
        service: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
        infrastructure: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
        hybrid: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      },
      size: {
        sm: "px-2 py-0.5 text-xs",
        md: "px-3 py-1 text-sm",
        lg: "px-4 py-1.5 text-base",
      },
    },
    defaultVariants: {
      archetype: "domain",
      size: "sm",
    },
  }
)

/**
 * Get display label for archetype (capitalizes first letter)
 */
function getArchetypeLabel(archetype: FeatureArchetype): string {
  return archetype.charAt(0).toUpperCase() + archetype.slice(1)
}

/**
 * ArchetypeBadge Component
 *
 * Displays an archetype badge with appropriate color styling.
 */
export function ArchetypeBadge({ archetype, size = "sm" }: ArchetypeBadgeProps) {
  const archetypeKey = archetype as VariantProps<typeof archetypeBadgeVariants>["archetype"]
  const sizeKey = size as VariantProps<typeof archetypeBadgeVariants>["size"]

  return (
    <span
      data-testid={`archetype-badge-${archetype}`}
      className={archetypeBadgeVariants({ archetype: archetypeKey, size: sizeKey })}
    >
      {archetype}
    </span>
  )
}
