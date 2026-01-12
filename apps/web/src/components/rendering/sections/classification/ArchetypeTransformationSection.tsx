/**
 * ArchetypeTransformationSection
 * Task: task-classification-001
 *
 * Displays the phase header and initial->validated archetype visual with
 * animated arrow transition. Includes 'Archetype Determination' title.
 *
 * Features:
 * - Phase header with Sparkles icon and 'Archetype Determination' title
 * - Initial archetype badge (or 'Unknown' placeholder)
 * - Animated ArrowRight icon between badges
 * - Validated archetype badge with Sparkles overlay
 * - Amber arrow color when archetype was corrected
 *
 * Data Source:
 * - ClassificationDecision from platformFeatures domain
 * - feature.initialAssessment.likelyArchetype as fallback
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { ArrowRight, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { useDomains } from "@/contexts/DomainProvider"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { ArchetypeBadge, type FeatureArchetype } from "@/components/app/shared"
import type { SectionRendererProps } from "../../types"

/**
 * ArchetypeTransformationSection - Classification phase header section
 *
 * Renders the archetype transformation visual showing Initial -> Validated
 * with animated arrow and phase header.
 */
export const ArchetypeTransformationSection = observer(function ArchetypeTransformationSection({
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

  // Get initial archetype from decision or feature
  const initialArchetype: FeatureArchetype | undefined =
    decision?.initialAssessment || feature?.initialAssessment?.likelyArchetype

  // Validated archetype from decision
  const validatedArchetype: FeatureArchetype | undefined = decision?.validatedArchetype

  // Check if there was a correction (initial differs from validated)
  const hasCorrection = useMemo(() => {
    return !!(
      decision &&
      initialArchetype &&
      validatedArchetype &&
      initialArchetype !== validatedArchetype
    )
  }, [decision, initialArchetype, validatedArchetype])

  return (
    <div data-testid="archetype-transformation-section" className="space-y-4">
      {/* Phase Header */}
      <div
        className={cn(
          "flex items-center gap-2 pb-2 border-b min-w-0",
          phaseColors.border
        )}
      >
        <Sparkles className={cn("h-5 w-5 shrink-0", phaseColors.text)} />
        <h2 className={cn("text-lg font-semibold truncate", phaseColors.text)}>
          Archetype Determination
        </h2>
      </div>

      {/* Transformation Visual */}
      {decision ? (
        <div
          data-testid="archetype-transformation"
          className="flex items-center justify-center gap-4 p-6 bg-gradient-to-r from-muted/30 via-pink-500/5 to-muted/30 rounded-lg border border-pink-500/20"
        >
          {/* Initial Archetype (left side) */}
          <div className="flex flex-col items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">
              Initial
            </span>
            {initialArchetype ? (
              <ArchetypeBadge archetype={initialArchetype} size="lg" />
            ) : (
              <div className="px-4 py-2 bg-muted/50 rounded-lg text-sm text-muted-foreground">
                Unknown
              </div>
            )}
          </div>

          {/* Animated Arrow */}
          <div className="flex flex-col items-center gap-1">
            <ArrowRight
              data-testid="transformation-arrow"
              className={cn(
                "h-8 w-8 animate-pulse",
                hasCorrection ? "text-amber-500" : phaseColors.text
              )}
            />
            {hasCorrection && (
              <span
                data-testid="corrected-label"
                className="text-xs text-amber-500 font-medium"
              >
                Corrected
              </span>
            )}
          </div>

          {/* Validated Archetype (right side) */}
          <div className="flex flex-col items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">
              Validated
            </span>
            <div className="relative">
              {validatedArchetype && (
                <>
                  <ArchetypeBadge archetype={validatedArchetype} size="lg" />
                  <Sparkles className="absolute -top-1 -right-1 h-4 w-4 text-pink-400" />
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        // Empty state - no classification decision yet
        <div
          data-testid="archetype-empty-state"
          className="p-6 bg-muted/30 rounded-lg text-center"
        >
          <Sparkles className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No classification decision yet. Run the classification phase to determine the feature archetype.
          </p>
        </div>
      )}
    </div>
  )
})

export default ArchetypeTransformationSection
