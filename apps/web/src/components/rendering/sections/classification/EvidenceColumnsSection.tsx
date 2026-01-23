/**
 * EvidenceColumnsSection
 * Task: task-classification-004
 *
 * Renders dual columns for supporting and opposing evidence analysis.
 * Shows Check icons for supporting evidence and X icons for opposing.
 *
 * Features:
 * - 'Evidence Analysis' heading in uppercase tracking-wide style
 * - Responsive grid: grid-cols-1 md:grid-cols-2 gap-6
 * - Supporting Evidence column with Check icons (green)
 * - Opposing Evidence column with X icons (red)
 * - ArchetypeBadge with '(Validated)' label in supporting column
 * - Empty column shows 'No evidence recorded' message
 *
 * Data Source:
 * - ClassificationDecision.evidenceChecklist from platformFeatures domain
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { Check, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useDomains } from "@shogo/app-core"
import { ArchetypeBadge, type FeatureArchetype } from "@/components/app/shared"
import type { SectionRendererProps } from "../../types"

/**
 * EvidenceColumn sub-component
 * Single column for evidence indicators
 */
function EvidenceColumn({
  title,
  archetype,
  items,
  isValidated,
  variant,
}: {
  title: string
  archetype?: FeatureArchetype
  items: Array<{ key: string; value: boolean }>
  isValidated?: boolean
  variant: "supporting" | "opposing"
}) {
  const isSupporting = variant === "supporting"

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        {archetype && <ArchetypeBadge archetype={archetype} size="sm" />}
        {isValidated && (
          <span className="text-xs text-pink-500 font-medium">(Validated)</span>
        )}
      </div>
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map(({ key }) => (
            <li key={key} className="flex items-start gap-2 text-sm">
              {isSupporting ? (
                <Check className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
              ) : (
                <X className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
              )}
              <span
                className={cn(
                  isSupporting ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {key}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground/60 italic">
          No evidence recorded
        </p>
      )}
    </div>
  )
}

/**
 * EvidenceColumnsSection - Dual column evidence analysis
 *
 * Renders a two-column grid showing supporting evidence (left)
 * and opposing evidence (right).
 */
export const EvidenceColumnsSection = observer(function EvidenceColumnsSection({
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

  // Parse evidence checklist into array format
  const evidenceItems = useMemo(() => {
    if (!decision?.evidenceChecklist) return []
    return Object.entries(decision.evidenceChecklist).map(([key, value]) => ({
      key,
      value: value as boolean,
    }))
  }, [decision?.evidenceChecklist])

  // Split evidence for dual column display
  const positiveEvidence = evidenceItems.filter((item) => item.value)
  const negativeEvidence = evidenceItems.filter((item) => !item.value)

  // Return null if no decision exists
  if (!decision) {
    return null
  }

  return (
    <section data-testid="evidence-columns-section">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Evidence Analysis
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4 bg-muted/20 rounded-lg">
        <EvidenceColumn
          title="Supporting Evidence"
          items={positiveEvidence}
          archetype={decision.validatedArchetype}
          isValidated={true}
          variant="supporting"
        />
        <EvidenceColumn
          title="Opposing Evidence"
          items={negativeEvidence}
          variant="opposing"
        />
      </div>
    </section>
  )
})

export default EvidenceColumnsSection
