/**
 * FindingMatrixSection
 * Task: task-analysis-004
 *
 * Renders Type x Location grid table with clickable cells for filtering findings.
 * Part of the composable Analysis phase view.
 *
 * Features:
 * - Finding types as rows, package locations as columns
 * - Count matrix showing findings per type/location combination
 * - Clickable cells trigger filter via AnalysisPanelContext
 * - Active cell highlighting
 * - Skips rows with zero findings
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { useDomains } from "@/contexts/DomainProvider"
import { useAnalysisPanelContext, type FindingType } from "./AnalysisPanelContext"
import { findingTypeBadgeVariants } from "@/components/app/shared"
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
 * Extract package name from a file path location
 */
function extractPackageName(location: string): string {
  const match = location.match(/(?:packages|apps|src)\/([^/]+)/)
  if (match) return match[1]
  const parts = location.split("/").filter(Boolean)
  return parts[0] || "other"
}

/**
 * FindingMatrixSection - Type x Location grid
 *
 * Displays a matrix of finding counts by type (rows) and location (columns).
 * Clicking a cell filters the findings list to that type/location combination.
 */
export const FindingMatrixSection = observer(function FindingMatrixSection({
  feature,
  config,
}: SectionRendererProps) {
  // Access shared context for filter state
  const { viewMode, activeFilter, setActiveFilter } = useAnalysisPanelContext()

  // Access platform-features domain for findings
  const { platformFeatures } = useDomains()
  const findings = platformFeatures?.analysisFindingCollection?.findBySession?.(feature?.id) ?? []

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

    FINDING_TYPE_ORDER.forEach((type) => {
      counts[type] = {}
      uniqueLocations.forEach((loc) => {
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

  // Handle cell click - toggle filter
  const handleCellClick = (type: FindingType | null, location: string | null) => {
    if (activeFilter.type === type && activeFilter.location === location) {
      // Clear filter if clicking same cell
      setActiveFilter({ type: null, location: null })
    } else {
      setActiveFilter({ type, location })
    }
  }

  // Only show matrix in matrix view mode
  if (viewMode !== "matrix") {
    return null
  }

  if (uniqueLocations.length === 0) {
    return (
      <div
        data-testid="finding-matrix-empty"
        className="text-sm text-muted-foreground text-center py-4"
      >
        No location data available
      </div>
    )
  }

  return (
    <section data-testid="finding-matrix-section">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Finding Matrix
      </h3>
      <div className="p-4 bg-muted/20 rounded-lg">
        <div data-testid="finding-type-matrix" className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left py-2 px-2 text-muted-foreground font-medium">
                  Type / Location
                </th>
                {uniqueLocations.map((loc) => (
                  <th
                    key={loc}
                    className="text-center py-2 px-2 text-muted-foreground font-medium cursor-pointer hover:text-violet-400"
                    onClick={() => handleCellClick(null, loc)}
                  >
                    {loc}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FINDING_TYPE_ORDER.map((type) => {
                const typeTotal = Object.values(matrix[type] || {}).reduce(
                  (a, b) => a + b,
                  0
                )
                if (typeTotal === 0) return null

                return (
                  <tr key={type} className="border-t border-border/50">
                    <td
                      className="py-2 px-2 font-medium cursor-pointer hover:text-violet-400"
                      onClick={() => handleCellClick(type, null)}
                    >
                      <span className={findingTypeBadgeVariants({ type })}>
                        {FINDING_TYPE_SHORT[type]}
                      </span>
                    </td>
                    {uniqueLocations.map((loc) => {
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
                          onClick={() => count > 0 && handleCellClick(type, loc)}
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
      </div>
    </section>
  )
})

export default FindingMatrixSection
