/**
 * FindingListSection
 * Task: task-analysis-005
 *
 * Displays filtered/grouped finding cards with filter indicator.
 * Part of the composable Analysis phase view.
 *
 * Features:
 * - Uses AnalysisPanelContext for viewMode and activeFilter state
 * - Filters findings based on activeFilter.type and activeFilter.location
 * - Filter indicator bar with Clear button when filter active
 * - In list mode without filter: groups by type with section headers
 * - In matrix mode or with filter: shows flat filtered list
 * - Uses DataCard primitive for finding display
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { Search, MapPin } from "lucide-react"
import { useDomains } from "@/contexts/DomainProvider"
import { DataCard } from "@/components/rendering/displays/visualization/DataCard"
import { useAnalysisPanelContext, type FindingType } from "./AnalysisPanelContext"
import { findingTypeBadgeVariants, FindingCard } from "@/components/app/shared"
import type { SectionRendererProps } from "../../types"

/**
 * Ordered list of finding types for display
 */
const FINDING_TYPE_ORDER: FindingType[] = [
  "pattern",
  "gap",
  "risk",
  "classification_evidence",
  "integration_point",
  "verification",
  "existing_test",
]

/**
 * Display labels for finding types
 */
const FINDING_TYPE_LABELS: Record<FindingType, string> = {
  pattern: "Patterns",
  gap: "Gaps",
  risk: "Risks",
  classification_evidence: "Evidence",
  integration_point: "Integration",
  verification: "Verification",
  existing_test: "Tests",
}

/**
 * Extract package name from a file path location
 */
function extractPackageName(location: string): string {
  const match = location.match(/(?:packages|apps|src)\/([^/]+)/)
  if (match) return match[1]
  const parts = location.split("/").filter(Boolean)
  return parts[0] || "other"
}

/**
 * Enhanced FindingCard using DataCard primitive
 */
function EnhancedFindingCard({ finding }: { finding: any }) {
  return (
    <DataCard
      title={finding.name || finding.id}
      description={finding.description || "No description"}
      variant="finding"
      phase="analysis"
      expandable
      metadata={
        <span className={findingTypeBadgeVariants({ type: finding.type })}>
          {FINDING_TYPE_LABELS[finding.type as FindingType] || finding.type}
        </span>
      }
    >
      <div className="space-y-3 text-sm">
        {finding.location && (
          <div className="flex items-start gap-2">
            <MapPin className="h-4 w-4 text-violet-400 mt-0.5" />
            <span className="text-muted-foreground font-mono text-xs">
              {finding.location}
            </span>
          </div>
        )}
        {finding.recommendation && (
          <div className="p-3 bg-violet-500/10 rounded border border-violet-500/20">
            <p className="text-muted-foreground">{finding.recommendation}</p>
          </div>
        )}
        {finding.relevantCode && (
          <pre className="p-3 bg-muted/50 rounded text-xs overflow-x-auto font-mono">
            {finding.relevantCode}
          </pre>
        )}
      </div>
    </DataCard>
  )
}

/**
 * FindingListSection - Filtered/grouped finding cards
 *
 * Displays findings as expandable cards. Behavior changes based on:
 * - viewMode: 'list' groups by type, 'matrix' shows flat when filtered
 * - activeFilter: filters findings to match type/location
 */
export const FindingListSection = observer(function FindingListSection({
  feature,
  config,
}: SectionRendererProps) {
  // Access shared context for view mode and filter
  const { viewMode, activeFilter, clearFilter } = useAnalysisPanelContext()

  // Access platform-features domain for findings
  const { platformFeatures } = useDomains()
  const findings = platformFeatures?.analysisFindingCollection?.findBySession?.(feature?.id) ?? []

  // Group findings by type
  const findingsByType = useMemo(() => {
    return FINDING_TYPE_ORDER.reduce(
      (acc, type) => {
        acc[type] = findings.filter((f: any) => f.type === type)
        return acc
      },
      {} as Record<FindingType, any[]>
    )
  }, [findings])

  // Filter findings based on active filter
  const filteredFindings = useMemo(() => {
    if (!activeFilter.type && !activeFilter.location) {
      return findings
    }

    return findings.filter((f: any) => {
      const typeMatch = !activeFilter.type || f.type === activeFilter.type
      const locationMatch =
        !activeFilter.location ||
        extractPackageName(f.location || "unknown") === activeFilter.location
      return typeMatch && locationMatch
    })
  }, [findings, activeFilter])

  // Determine if we have an active filter
  const hasActiveFilter = activeFilter.type !== null || activeFilter.location !== null

  // Empty state
  if (findings.length === 0) {
    return (
      <section
        data-testid="finding-list-empty"
        className="p-6 bg-muted/30 rounded-lg text-center"
      >
        <Search className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">
          No findings captured yet. Run the analysis phase to discover patterns, gaps,
          and risks.
        </p>
      </section>
    )
  }

  // Show list when: in list mode OR when there's an active filter
  const showList = viewMode === "list" || hasActiveFilter

  if (!showList) {
    return null
  }

  return (
    <section data-testid="finding-list-section">
      {/* Active Filter Indicator */}
      {hasActiveFilter && (
        <div className="flex items-center gap-2 p-2 bg-violet-500/10 rounded-lg border border-violet-500/20 mb-4">
          <span className="text-sm text-violet-400">
            Filtered by:
            {activeFilter.type && ` ${FINDING_TYPE_LABELS[activeFilter.type]}`}
            {activeFilter.type && activeFilter.location && " in"}
            {activeFilter.location && ` ${activeFilter.location}`}
          </span>
          <button
            onClick={clearFilter}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Clear
          </button>
        </div>
      )}

      {/* Filtered Findings Header */}
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        {hasActiveFilter
          ? `Filtered Findings (${filteredFindings.length})`
          : "All Findings"}
      </h3>

      {/* Flat filtered list (when filter is active or in matrix view with filter) */}
      {hasActiveFilter && (
        <div className="space-y-3">
          {filteredFindings.map((finding: any) => (
            <EnhancedFindingCard key={finding.id} finding={finding} />
          ))}
        </div>
      )}

      {/* Grouped list view (only in list mode without filter) */}
      {viewMode === "list" && !hasActiveFilter && (
        <div className="space-y-6">
          {FINDING_TYPE_ORDER.map((type) => {
            const typeFindings = findingsByType[type]
            if (typeFindings.length === 0) return null

            return (
              <div key={type}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={findingTypeBadgeVariants({ type })}>
                    {FINDING_TYPE_LABELS[type]} ({typeFindings.length})
                  </span>
                </div>
                <div className="space-y-2">
                  {typeFindings.map((finding: any) => (
                    <FindingCard key={finding.id} finding={finding} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
})

export default FindingListSection
