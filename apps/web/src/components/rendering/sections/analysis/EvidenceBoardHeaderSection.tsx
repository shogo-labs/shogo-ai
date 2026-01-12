/**
 * EvidenceBoardHeaderSection
 * Task: task-analysis-002
 *
 * Displays the Analysis phase header with finding count and view mode toggle.
 * Part of the composable Analysis phase view.
 *
 * Features:
 * - 'Evidence Board' title with Search icon
 * - Finding count from platformFeatures domain
 * - Matrix/List view toggle buttons
 * - Uses AnalysisPanelContext for viewMode state
 */

import { observer } from "mobx-react-lite"
import { Search, Grid, List } from "lucide-react"
import { cn } from "@/lib/utils"
import { useDomains } from "@/contexts/DomainProvider"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { useAnalysisPanelContext } from "./AnalysisPanelContext"
import type { SectionRendererProps } from "../../types"

/**
 * EvidenceBoardHeaderSection - Analysis phase header section
 *
 * Renders the header bar with title, finding count, and view mode toggle.
 * Connected to AnalysisPanelContext for shared viewMode state.
 */
export const EvidenceBoardHeaderSection = observer(function EvidenceBoardHeaderSection({
  feature,
  config,
}: SectionRendererProps) {
  // Phase colors for analysis (violet)
  const phaseColors = usePhaseColor("analysis")

  // Access shared context for view mode
  const { viewMode, setViewMode } = useAnalysisPanelContext()

  // Access platform-features domain for finding count
  const { platformFeatures } = useDomains()
  const findings = platformFeatures?.analysisFindingCollection?.findBySession?.(feature?.id) ?? []
  const findingCount = findings.length

  return (
    <div
      data-testid="evidence-board-header"
      className={cn(
        "flex items-center justify-between pb-2 border-b min-w-0",
        phaseColors.border
      )}
    >
      {/* Title Section */}
      <div className="flex items-center gap-2 min-w-0">
        <Search className={cn("h-5 w-5 shrink-0", phaseColors.text)} />
        <h2 className={cn("text-lg font-semibold truncate", phaseColors.text)}>
          Evidence Board
        </h2>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          ({findingCount} {findingCount === 1 ? "finding" : "findings"})
        </span>
      </div>

      {/* View Toggle */}
      <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1">
        <button
          data-testid="view-mode-matrix"
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
          data-testid="view-mode-list"
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
  )
})

export default EvidenceBoardHeaderSection
