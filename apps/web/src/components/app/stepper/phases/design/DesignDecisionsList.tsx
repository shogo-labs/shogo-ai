/**
 * DesignDecisionsList Component
 * Task: task-2-3c-010
 *
 * Displays a list of design decisions for a feature session.
 * Uses observer() wrapper and queries platformFeatures domain.
 *
 * Per design-2-3c-012:
 * - Wrapped with observer() for MobX reactivity
 * - Queries designDecisionCollection filtered by session
 * - Excludes enhancement-hooks-plan (shown in separate tab)
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { DesignDecisionCard } from "./DesignDecisionCard"

/**
 * Props for DesignDecisionsList component
 */
export interface DesignDecisionsListProps {
  featureId: string
}

/**
 * DesignDecisionsList Component
 *
 * Renders a list of design decisions for the specified feature.
 */
export const DesignDecisionsList = observer(function DesignDecisionsList({
  featureId,
}: DesignDecisionsListProps) {
  const { platformFeatures } = useDomains<{ platformFeatures: any }>()

  // Query design decisions for this feature session
  // Filter out enhancement-hooks-plan (shown in separate tab)
  const decisions = platformFeatures?.designDecisionCollection
    ?.all()
    .filter(
      (d: any) =>
        d.session?.id === featureId && d.name !== "enhancement-hooks-plan"
    )
    .sort((a: any, b: any) => (a.createdAt ?? 0) - (b.createdAt ?? 0)) ?? []

  // Empty state
  if (decisions.length === 0) {
    return (
      <div
        data-testid="design-decisions-list"
        className="flex flex-col items-center justify-center p-8 text-center"
      >
        <p className="text-muted-foreground">
          No design decisions recorded for this feature.
        </p>
      </div>
    )
  }

  return (
    <div
      data-testid="design-decisions-list"
      className="flex flex-col gap-4"
    >
      {decisions.map((decision: any) => (
        <DesignDecisionCard key={decision.id} decision={decision} />
      ))}
    </div>
  )
})
