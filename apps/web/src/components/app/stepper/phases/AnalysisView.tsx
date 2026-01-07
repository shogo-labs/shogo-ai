/**
 * AnalysisView Component - Redesigned
 * Task: task-w2-analysis-view-redesign
 *
 * "Evidence Board + Matrix" hybrid aesthetic with:
 * - FindingTypeMatrix: Type x Location grid with clickable cells
 * - Enhanced FindingCard using DataCard primitive with severity indicators
 * - LocationHeatBar: Finding density per package using ProgressBar
 * - Toggle between matrix and list views
 *
 * Uses phase-analysis color tokens (violet) throughout.
 */

import { observer } from "mobx-react-lite"
import { useState, useMemo } from "react"
import { useDomains } from "@/contexts/DomainProvider"
import { cn } from "@/lib/utils"
import { Grid, List, Search, MapPin } from "lucide-react"
import { ProgressBar } from "@/components/rendering/displays/visualization/ProgressBar"
import { DataCard } from "@/components/rendering/displays/visualization/DataCard"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import {
  FindingCard,
  findingTypeBadgeVariants,
  type Finding,
  type FindingType,
} from "../../shared"

/**
 * Feature type for AnalysisView
 */
export interface AnalysisFeature {
  id: string
  name: string
  status: string
}

/**
 * Props for AnalysisView component
 */
export interface AnalysisViewProps {
  /** Feature session to display */
  feature: AnalysisFeature
}

/**
 * View mode type
 */
type ViewMode = "matrix" | "list"

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
 * Short labels for matrix cells
 */
const FINDING_TYPE_SHORT: Record<FindingType, string> = {
  pattern: "PAT",
  gap: "GAP",
  risk: "RSK",
  classification_evidence: "EVD",
  integration_point: "INT",
  verification: "VER",
  existing_test: "TST",
}

/**
 * Extract package name from location path
 */
function extractPackageName(location: string): string {
  // Extract the main package/folder name
  const match = location.match(/(?:packages|apps|src)\/([^/]+)/)
  if (match) return match[1]

  // Fallback: use first meaningful segment
  const parts = location.split("/").filter(Boolean)
  return parts[0] || "other"
}

/**
 * LocationHeatBar Component
 * Shows finding density per package using ProgressBar
 */
function LocationHeatBar({ findings }: { findings: any[] }) {
  const locationSegments = useMemo(() => {
    const locationCounts = new Map<string, number>()

    findings.forEach((f: any) => {
      const pkg = extractPackageName(f.location || "unknown")
      locationCounts.set(pkg, (locationCounts.get(pkg) || 0) + 1)
    })

    const total = findings.length
    if (total === 0) return []

    const colors = [
      "#8b5cf6", // violet-500
      "#a78bfa", // violet-400
      "#c4b5fd", // violet-300
      "#7c3aed", // violet-600
      "#6d28d9", // violet-700
    ]

    return Array.from(locationCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([pkg, count], index) => ({
        value: (count / total) * 100,
        color: colors[index % colors.length],
        label: `${pkg} (${count})`,
      }))
  }, [findings])

  if (locationSegments.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      <ProgressBar
        variant="stacked"
        segments={locationSegments}
        height={10}
        ariaLabel="Finding distribution by location"
      />
      <div className="flex flex-wrap gap-3 text-xs">
        {locationSegments.map((seg, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div
              className="w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: seg.color }}
            />
            <span className="text-muted-foreground">{seg.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * FindingTypeMatrix Component
 * Type x Location grid with clickable cells
 */
function FindingTypeMatrix({
  findings,
  onCellClick,
  activeFilter,
}: {
  findings: any[]
  onCellClick: (type: FindingType | null, location: string | null) => void
  activeFilter: { type: FindingType | null; location: string | null }
}) {
  // Extract unique locations
  const uniqueLocations = useMemo(() => {
    const locations = new Set<string>()
    findings.forEach((f: any) => {
      locations.add(extractPackageName(f.location || "unknown"))
    })
    return Array.from(locations).sort()
  }, [findings])

  // Build count matrix
  const matrix = useMemo(() => {
    const counts: Record<string, Record<string, number>> = {}

    FINDING_TYPE_ORDER.forEach(type => {
      counts[type] = {}
      uniqueLocations.forEach(loc => {
        counts[type][loc] = 0
      })
    })

    findings.forEach((f: any) => {
      const type = f.type as FindingType
      const loc = extractPackageName(f.location || "unknown")
      if (counts[type] && counts[type][loc] !== undefined) {
        counts[type][loc]++
      }
    })

    return counts
  }, [findings, uniqueLocations])

  if (uniqueLocations.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        No location data available
      </div>
    )
  }

  return (
    <div data-testid="finding-type-matrix" className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-left py-2 px-2 text-muted-foreground font-medium">
              Type / Location
            </th>
            {uniqueLocations.map(loc => (
              <th
                key={loc}
                className="text-center py-2 px-2 text-muted-foreground font-medium cursor-pointer hover:text-violet-400"
                onClick={() => onCellClick(null, loc)}
              >
                {loc}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FINDING_TYPE_ORDER.map(type => {
            const typeTotal = Object.values(matrix[type] || {}).reduce((a, b) => a + b, 0)
            if (typeTotal === 0) return null

            return (
              <tr key={type} className="border-t border-border/50">
                <td
                  className="py-2 px-2 font-medium cursor-pointer hover:text-violet-400"
                  onClick={() => onCellClick(type, null)}
                >
                  <span className={findingTypeBadgeVariants({ type })}>
                    {FINDING_TYPE_SHORT[type]}
                  </span>
                </td>
                {uniqueLocations.map(loc => {
                  const count = matrix[type]?.[loc] || 0
                  const isActive =
                    activeFilter.type === type && activeFilter.location === loc

                  return (
                    <td
                      key={loc}
                      className={cn(
                        "text-center py-2 px-2 cursor-pointer transition-colors",
                        count > 0
                          ? "hover:bg-violet-500/20"
                          : "text-muted-foreground/30",
                        isActive && "bg-violet-500/30 ring-1 ring-violet-500"
                      )}
                      onClick={() => count > 0 && onCellClick(type, loc)}
                    >
                      {count > 0 ? count : "-"}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Enhanced FindingCard using DataCard
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
 * AnalysisView Component
 *
 * Displays the Analysis phase with "Evidence Board + Matrix" aesthetic:
 * 1. LocationHeatBar - Finding density per package
 * 2. FindingTypeMatrix - Type x Location grid with clickable filtering
 * 3. Enhanced FindingCards - Using DataCard primitive
 * 4. Toggle between matrix and list views
 */
export const AnalysisView = observer(function AnalysisView({
  feature,
}: AnalysisViewProps) {
  // Phase colors for analysis (violet)
  const phaseColors = usePhaseColor("analysis")

  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>("matrix")

  // Filter state
  const [activeFilter, setActiveFilter] = useState<{
    type: FindingType | null
    location: string | null
  }>({ type: null, location: null })

  // Access platform-features domain for findings
  const { platformFeatures } = useDomains()

  // Fetch findings for this feature session
  const findings = platformFeatures?.analysisFindingCollection?.findBySession?.(feature.id) ?? []

  // Group findings by type
  const findingsByType = useMemo(() => {
    return FINDING_TYPE_ORDER.reduce((acc, type) => {
      acc[type] = findings.filter((f: any) => f.type === type)
      return acc
    }, {} as Record<FindingType, Finding[]>)
  }, [findings])

  // Filtered findings based on active filter
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

  // Handle matrix cell click
  const handleCellClick = (type: FindingType | null, location: string | null) => {
    if (activeFilter.type === type && activeFilter.location === location) {
      // Clear filter if clicking same cell
      setActiveFilter({ type: null, location: null })
    } else {
      setActiveFilter({ type, location })
    }
  }

  // Clear filter
  const clearFilter = () => {
    setActiveFilter({ type: null, location: null })
  }

  return (
    <div data-testid="analysis-view" className="space-y-6 overflow-hidden">
      {/* Evidence Board Header */}
      <div className={cn("flex items-center justify-between pb-2 border-b min-w-0", phaseColors.border)}>
        <div className="flex items-center gap-2 min-w-0">
          <Search className={cn("h-5 w-5 shrink-0", phaseColors.text)} />
          <h2 className={cn("text-lg font-semibold truncate", phaseColors.text)}>
            Evidence Board
          </h2>
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            ({findings.length} findings)
          </span>
        </div>

        {/* View Toggle */}
        <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1">
          <button
            onClick={() => setViewMode("matrix")}
            className={cn(
              "p-2 rounded transition-colors",
              viewMode === "matrix"
                ? "bg-violet-500/20 text-violet-400"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Matrix view"
          >
            <Grid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={cn(
              "p-2 rounded transition-colors",
              viewMode === "list"
                ? "bg-violet-500/20 text-violet-400"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="List view"
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Location Heat Bar */}
      {findings.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Location Distribution
          </h3>
          <LocationHeatBar findings={findings} />
        </section>
      )}

      {/* Active Filter Indicator */}
      {(activeFilter.type || activeFilter.location) && (
        <div className="flex items-center gap-2 p-2 bg-violet-500/10 rounded-lg border border-violet-500/20">
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

      {/* Empty State */}
      {findings.length === 0 ? (
        <section className="p-6 bg-muted/30 rounded-lg text-center">
          <Search className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No findings captured yet. Run the analysis phase to discover patterns, gaps, and risks.
          </p>
        </section>
      ) : viewMode === "matrix" ? (
        /* Matrix View */
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Finding Matrix
          </h3>
          <div className="p-4 bg-muted/20 rounded-lg">
            <FindingTypeMatrix
              findings={findings}
              onCellClick={handleCellClick}
              activeFilter={activeFilter}
            />
          </div>
        </section>
      ) : null}

      {/* Findings List (shown in both views when filtered, or in list mode) */}
      {findings.length > 0 && (viewMode === "list" || activeFilter.type || activeFilter.location) && (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            {activeFilter.type || activeFilter.location
              ? `Filtered Findings (${filteredFindings.length})`
              : "All Findings"}
          </h3>
          <div className="space-y-3">
            {filteredFindings.map((finding: any) => (
              <EnhancedFindingCard key={finding.id} finding={finding} />
            ))}
          </div>
        </section>
      )}

      {/* Grouped List View (only in list mode without filter) */}
      {viewMode === "list" && !activeFilter.type && !activeFilter.location && findings.length > 0 && (
        <div className="space-y-6">
          {FINDING_TYPE_ORDER.map((type) => {
            const typeFindings = findingsByType[type]
            if (typeFindings.length === 0) return null

            return (
              <section key={type}>
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
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
})
