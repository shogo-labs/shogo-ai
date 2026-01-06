/**
 * ClassificationView Component
 * Task: task-2-3b-009
 *
 * Displays the Classification phase content: archetype, evidence, patterns, rationale.
 *
 * Props:
 * - feature: FeatureForPanel with id, name, status, applicablePatterns
 *
 * Per design-2-3b-component-hierarchy:
 * - Built in /components/app/stepper/phases/
 * - Uses useDomains() for data access
 * - Wrapped with observer() for MobX reactivity
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { cn } from "@/lib/utils"
import {
  ArchetypeBadge,
  PatternChips,
  EvidenceChecklist,
  type FeatureArchetype,
} from "../../shared"

/**
 * Classification decision type
 */
interface ClassificationDecision {
  id: string
  session: { id: string }
  initialAssessment?: FeatureArchetype
  validatedArchetype: FeatureArchetype
  evidenceChecklist?: Record<string, boolean>
  rationale: string
  correction?: string
}

/**
 * Extended feature type for ClassificationView
 */
export interface ClassificationFeature {
  id: string
  name: string
  status: string
  applicablePatterns?: string[]
}

/**
 * Props for ClassificationView component
 */
export interface ClassificationViewProps {
  /** Feature session to display */
  feature: ClassificationFeature
}

/**
 * ClassificationView Component
 *
 * Displays:
 * 1. Validated archetype badge
 * 2. Correction note (if initial differs from validated)
 * 3. Evidence checklist
 * 4. Applicable patterns
 * 5. Classification rationale
 */
export const ClassificationView = observer(function ClassificationView({
  feature,
}: ClassificationViewProps) {
  // Access platform-features domain for classification decision
  const { platformFeatures } = useDomains<{
    platformFeatures: {
      classificationDecisionCollection: {
        all: () => ClassificationDecision[]
      }
    }
  }>()

  // Fetch classification decision for this feature session
  // Note: Using inline filter as classificationDecisionCollection lacks findBySession
  const decision = platformFeatures?.classificationDecisionCollection
    ?.all?.()
    ?.filter((d: any) => d.session?.id === feature.id)?.[0] as ClassificationDecision | undefined

  // Check if there was a correction (initial differs from validated)
  const hasCorrection = decision &&
    decision.initialAssessment &&
    decision.initialAssessment !== decision.validatedArchetype

  return (
    <div data-testid="classification-view" className="space-y-6">
      {!decision ? (
        // Empty state - no classification decision yet
        <section className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No classification decision yet. Run the classification phase to determine the feature archetype.
          </p>
        </section>
      ) : (
        <>
          {/* Archetype Section */}
          <section>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Validated Archetype
            </h3>
            <div className="flex items-center gap-3">
              <ArchetypeBadge archetype={decision.validatedArchetype} size="md" />
              {hasCorrection && (
                <span className="text-sm text-muted-foreground">
                  (corrected from{" "}
                  <span className="font-medium">{decision.initialAssessment}</span>)
                </span>
              )}
            </div>
          </section>

          {/* Correction Note (if applicable) */}
          {decision.correction && (
            <section>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Correction Note
              </h3>
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  {decision.correction}
                </p>
              </div>
            </section>
          )}

          {/* Evidence Checklist */}
          <section>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Evidence Checklist
            </h3>
            <div className="p-4 bg-muted/30 rounded-lg">
              <EvidenceChecklist evidence={decision.evidenceChecklist as Record<string, boolean>} />
            </div>
          </section>

          {/* Applicable Patterns */}
          {feature.applicablePatterns && feature.applicablePatterns.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Applicable Patterns
              </h3>
              <PatternChips patterns={feature.applicablePatterns} />
            </section>
          )}

          {/* Rationale */}
          <section>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Rationale
            </h3>
            <div className="p-4 bg-muted/50 rounded-lg">
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {decision.rationale}
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  )
})
