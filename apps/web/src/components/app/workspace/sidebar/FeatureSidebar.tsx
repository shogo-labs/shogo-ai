/**
 * FeatureSidebar Component
 * Task: task-2-2-005
 *
 * Main sidebar component containing search, feature groups, and new feature button.
 * Manages local search state for filtering features.
 *
 * Layout (flex-col):
 * - SidebarSearch at top
 * - FeatureGroups in middle (scrollable)
 * - NewFeatureButton at bottom
 *
 * Props:
 * - featuresByPhase: Features grouped by phase
 * - currentFeatureId: Currently selected feature ID
 * - onFeatureSelect: Callback when feature is selected
 * - onNewFeature: Callback when new feature button is clicked
 * - projectId: Current project ID (null if none selected)
 *
 * Per design-2-2-clean-break:
 * - Built fresh in /components/app/workspace/sidebar/
 * - Zero imports from /components/Studio/
 */

import { useState, useMemo } from "react"
import { SidebarSearch } from "./SidebarSearch"
import { FeatureGroup, FEATURE_PHASES } from "./FeatureGroup"
import { NewFeatureButton } from "./NewFeatureButton"
import type { Feature } from "./FeatureItem"

/**
 * Props for FeatureSidebar component
 */
export interface FeatureSidebarProps {
  /** Features grouped by phase */
  featuresByPhase: Record<string, Feature[]>
  /** Currently selected feature ID (null if none) */
  currentFeatureId: string | null
  /** Callback when a feature is selected */
  onFeatureSelect: (id: string) => void
  /** Callback when new feature button is clicked */
  onNewFeature: () => void
  /** Current project ID (null disables new feature button) */
  projectId?: string | null
}

/**
 * Filter features by search query
 * Matches against feature name and intent (case-insensitive)
 */
function filterFeatures(features: Feature[], query: string): Feature[] {
  if (!query.trim()) {
    return features
  }
  const lowerQuery = query.toLowerCase()
  return features.filter(
    (f) =>
      f.name.toLowerCase().includes(lowerQuery) ||
      f.intent?.toLowerCase().includes(lowerQuery)
  )
}

/**
 * FeatureSidebar Component
 *
 * Renders the sidebar with:
 * - Search input at top
 * - Feature groups in scrollable middle section
 * - New feature button at bottom
 *
 * Manages local searchQuery state for filtering features.
 */
export function FeatureSidebar({
  featuresByPhase,
  currentFeatureId,
  onFeatureSelect,
  onNewFeature,
  projectId,
}: FeatureSidebarProps) {
  // Local state for search query
  const [searchQuery, setSearchQuery] = useState("")

  // Filter features by search query using useMemo for performance
  const filteredFeaturesByPhase = useMemo(() => {
    const filtered: Record<string, Feature[]> = {}

    for (const phase of FEATURE_PHASES) {
      const phaseKey = phase.toLowerCase()
      const features = featuresByPhase[phaseKey] || []
      filtered[phaseKey] = filterFeatures(features, searchQuery)
    }

    return filtered
  }, [featuresByPhase, searchQuery])

  return (
    <div
      className="flex flex-col h-full"
      data-testid="feature-sidebar"
    >
      {/* Search at top */}
      <div className="p-3 border-b border-border">
        <SidebarSearch
          value={searchQuery}
          onChange={setSearchQuery}
        />
      </div>

      {/* Feature groups in scrollable middle section */}
      <div className="flex-1 overflow-y-auto py-2">
        {FEATURE_PHASES.map((phase) => {
          const phaseKey = phase.toLowerCase()
          const features = filteredFeaturesByPhase[phaseKey] || []

          return (
            <FeatureGroup
              key={phase}
              phase={phase}
              features={features}
              currentFeatureId={currentFeatureId}
              onFeatureSelect={onFeatureSelect}
            />
          )
        })}

        {/* Show message when no features match search */}
        {searchQuery && Object.values(filteredFeaturesByPhase).every(f => f.length === 0) && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No features match "{searchQuery}"
          </div>
        )}
      </div>

      {/* New feature button at bottom */}
      <div className="p-3 border-t border-border">
        <NewFeatureButton
          onClick={onNewFeature}
          disabled={!projectId}
        />
      </div>
    </div>
  )
}
