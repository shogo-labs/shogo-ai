/**
 * ApplicablePatternsSection
 * Task: task-classification-005
 *
 * Displays applicable patterns as chips using the PatternChips shared component.
 * Returns null when no patterns exist (conditional render).
 *
 * Features:
 * - Returns null when feature.applicablePatterns is empty or undefined
 * - 'Applicable Patterns' heading in uppercase tracking-wide style
 * - Uses PatternChips shared component for rendering
 *
 * Data Source:
 * - feature.applicablePatterns from props (not from decision)
 */

import { observer } from "mobx-react-lite"
import { PatternChips } from "@/components/app/shared"
import type { SectionRendererProps } from "../../types"

/**
 * ApplicablePatternsSection - Pattern chips display
 *
 * Conditionally renders pattern chips when the feature has
 * applicable patterns defined.
 */
export const ApplicablePatternsSection = observer(function ApplicablePatternsSection({
  feature,
  config,
}: SectionRendererProps) {
  // Get patterns from feature
  const patterns = feature?.applicablePatterns

  // Return null if no patterns
  if (!patterns || patterns.length === 0) {
    return null
  }

  return (
    <section data-testid="applicable-patterns-section">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Applicable Patterns
      </h3>
      <PatternChips patterns={patterns} />
    </section>
  )
})

export default ApplicablePatternsSection
