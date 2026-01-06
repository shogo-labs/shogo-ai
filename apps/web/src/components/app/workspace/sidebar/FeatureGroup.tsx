/**
 * FeatureGroup Component
 * Task: task-2-2-005
 *
 * Renders a group of features for a specific phase.
 * Shows phase header with count badge and list of FeatureItems.
 *
 * Props:
 * - phase: Phase name to display
 * - features: Array of features in this phase
 * - currentFeatureId: ID of currently selected feature
 * - onFeatureSelect: Callback when a feature is selected
 *
 * Per design-2-2-clean-break:
 * - Built fresh in /components/app/workspace/sidebar/
 * - Zero imports from /components/Studio/
 */

import { FeatureItem, type Feature } from "./FeatureItem"
import { Badge } from "@/components/ui/badge"

/**
 * All 8 phases in the platform features workflow
 * These match the status values in FeatureSession
 */
export const FEATURE_PHASES = [
  "Discovery",
  "Analysis",
  "Classification",
  "Design",
  "Spec",
  "Testing",
  "Implementation",
  "Complete",
] as const

/**
 * Phase type derived from FEATURE_PHASES constant
 */
export type FeaturePhase = (typeof FEATURE_PHASES)[number]

/**
 * Props for FeatureGroup component
 */
export interface FeatureGroupProps {
  /** Phase name to display (e.g., "Discovery", "Design") */
  phase: string
  /** Features in this phase */
  features: Feature[]
  /** ID of currently selected feature (null if none) */
  currentFeatureId: string | null
  /** Callback when a feature is selected */
  onFeatureSelect: (id: string) => void
}

/**
 * FeatureGroup Component
 *
 * Renders a section for a specific phase with:
 * - Header showing phase name and count badge
 * - List of FeatureItems for each feature in the phase
 */
export function FeatureGroup({
  phase,
  features,
  currentFeatureId,
  onFeatureSelect,
}: FeatureGroupProps) {
  // Don't render empty groups
  if (features.length === 0) {
    return null
  }

  return (
    <div className="mb-4" data-testid={`feature-group-${phase.toLowerCase()}`}>
      {/* Phase header with count badge */}
      <div className="flex items-center justify-between px-3 py-2">
        <h3 className="text-sm font-semibold text-foreground capitalize">{phase}</h3>
        <Badge variant="secondary" className="text-xs">
          {features.length}
        </Badge>
      </div>

      {/* Feature items */}
      <div className="space-y-1">
        {features.map((feature) => (
          <FeatureItem
            key={feature.id}
            feature={feature}
            isSelected={feature.id === currentFeatureId}
            onClick={() => onFeatureSelect(feature.id)}
          />
        ))}
      </div>
    </div>
  )
}
