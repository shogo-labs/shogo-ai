/**
 * CorrectionNoteSection
 * Task: task-classification-002
 *
 * Displays conditional correction notice when archetype was changed during
 * classification. Only renders when a correction exists.
 *
 * Features:
 * - Returns null when no correction (conditional render)
 * - Amber-styled container with AlertTriangle icon
 * - 'Classification Corrected' heading
 * - Correction text from decision
 *
 * Data Source:
 * - ClassificationDecision.correction from platformFeatures domain
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { AlertTriangle } from "lucide-react"
import { useDomains } from "@shogo/app-core"
import type { SectionRendererProps } from "../../types"

/**
 * CorrectionNoteSection - Classification correction notice
 *
 * Conditionally renders a correction notice when the archetype was
 * changed during the classification phase.
 */
export const CorrectionNoteSection = observer(function CorrectionNoteSection({
  feature,
  config,
}: SectionRendererProps) {
  // Access platform-features domain for classification decision
  const { platformFeatures } = useDomains()

  // Fetch classification decision for this feature session
  const decision = useMemo(() => {
    const decisions = platformFeatures?.classificationDecisionCollection?.all?.() ?? []
    return decisions.find((d: any) => d.session?.id === feature?.id)
  }, [platformFeatures?.classificationDecisionCollection, feature?.id])

  // Get initial archetype from decision or feature
  const initialArchetype =
    decision?.initialAssessment || feature?.initialAssessment?.likelyArchetype

  // Check if there was a correction
  const hasCorrection = !!(
    decision &&
    initialArchetype &&
    decision.validatedArchetype &&
    initialArchetype !== decision.validatedArchetype
  )

  // Return null if no correction or no correction text
  if (!hasCorrection || !decision?.correction) {
    return null
  }

  return (
    <section
      data-testid="correction-note-section"
      className="p-4 bg-amber-500/10 rounded-lg border border-amber-500/20"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
        <div>
          <h4 className="text-sm font-semibold text-amber-500 mb-1">
            Classification Corrected
          </h4>
          <p className="text-sm text-muted-foreground">
            {decision.correction}
          </p>
        </div>
      </div>
    </section>
  )
})

export default CorrectionNoteSection
