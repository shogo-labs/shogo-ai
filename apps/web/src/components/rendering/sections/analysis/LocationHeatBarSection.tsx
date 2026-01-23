/**
 * LocationHeatBarSection
 * Task: task-analysis-003
 *
 * Displays finding distribution by package location as a stacked ProgressBar.
 * Part of the composable Analysis phase view.
 *
 * Features:
 * - Extracts package names from finding locations
 * - Calculates percentage distribution per package
 * - Uses ProgressBar with stacked variant
 * - Color-coded legend with package names and counts
 * - Violet color palette
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { useDomains } from "@shogo/app-core"
import { ProgressBar } from "@/components/rendering"
import type { SectionRendererProps } from "../../types"

/**
 * Extract package name from a file path location
 *
 * @example
 * extractPackageName("packages/state-api/src/foo.ts") => "state-api"
 * extractPackageName("apps/web/src/bar.tsx") => "web"
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
 * Violet color palette for location segments
 */
const VIOLET_COLORS = [
  "#8b5cf6", // violet-500
  "#a78bfa", // violet-400
  "#c4b5fd", // violet-300
  "#7c3aed", // violet-600
  "#6d28d9", // violet-700
]

/**
 * LocationHeatBarSection - Finding distribution visualization
 *
 * Shows a stacked progress bar representing the distribution of findings
 * across different packages/locations in the codebase.
 */
export const LocationHeatBarSection = observer(function LocationHeatBarSection({
  feature,
  config,
}: SectionRendererProps) {
  // Access platform-features domain for findings
  const { platformFeatures } = useDomains()
  const findings = platformFeatures?.analysisFindingCollection?.findBySession?.(feature?.id) ?? []

  // Calculate location segments for the progress bar
  const locationSegments = useMemo(() => {
    const locationCounts = new Map<string, number>()

    findings.forEach((f: any) => {
      const pkg = extractPackageName(f.location || "unknown")
      locationCounts.set(pkg, (locationCounts.get(pkg) || 0) + 1)
    })

    const total = findings.length
    if (total === 0) return []

    return Array.from(locationCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([pkg, count], index) => ({
        value: (count / total) * 100,
        color: VIOLET_COLORS[index % VIOLET_COLORS.length],
        label: `${pkg} (${count})`,
      }))
  }, [findings])

  // Return null if no findings
  if (locationSegments.length === 0) {
    return null
  }

  return (
    <div data-testid="location-heat-bar" className="space-y-2">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Location Distribution
      </h3>
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
})

export default LocationHeatBarSection
