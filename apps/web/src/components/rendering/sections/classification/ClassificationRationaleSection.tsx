/**
 * ClassificationRationaleSection
 * Task: task-classification-006
 *
 * Displays the classification rationale text in a styled card with
 * pink theme border.
 *
 * Features:
 * - 'Classification Rationale' heading in uppercase tracking-wide style
 * - Pink-themed border from usePhaseColor('classification')
 * - Rationale text with whitespace-pre-wrap for formatting
 * - Returns null when no decision exists
 *
 * Data Source:
 * - ClassificationDecision.rationale from platformFeatures domain
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { useDomains } from "@shogo/app-core"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import type { SectionRendererProps } from "../../types"

/**
 * ClassificationRationaleSection - Rationale text display
 *
 * Renders the classification rationale in a themed card with
 * proper formatting and pink border styling.
 */
export const ClassificationRationaleSection = observer(function ClassificationRationaleSection({
  feature,
  config,
}: SectionRendererProps) {
  // Phase colors for classification (pink)
  const phaseColors = usePhaseColor("classification")

  // Access platform-features domain for classification decision
  const { platformFeatures } = useDomains()

  // Fetch classification decision for this feature session
  const decision = useMemo(() => {
    const decisions = platformFeatures?.classificationDecisionCollection?.all?.() ?? []
    return decisions.find((d: any) => d.session?.id === feature?.id)
  }, [platformFeatures?.classificationDecisionCollection, feature?.id])

  // Return null if no decision exists
  if (!decision) {
    return null
  }

  return (
    <section data-testid="classification-rationale-section">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Classification Rationale
      </h3>
      <div
        className={cn(
          "p-4 rounded-lg border",
          phaseColors.border,
          "bg-pink-500/5"
        )}
      >
        <p className="text-sm text-foreground whitespace-pre-wrap">
          {decision.rationale}
        </p>
      </div>
    </section>
  )
})

export default ClassificationRationaleSection
