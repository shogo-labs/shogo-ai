/**
 * AnalysisView Component
 * Task: task-2-3b-008
 *
 * Displays the Analysis phase content: findings grouped by type with flat sections.
 *
 * Props:
 * - feature: FeatureForPanel with id, name, status
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
 * Ordered list of finding types for display
 * Priority: patterns, gaps, risks, then other types
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
  classification_evidence: "Classification Evidence",
  integration_point: "Integration Points",
  verification: "Verifications",
  existing_test: "Existing Tests",
}

/**
 * AnalysisView Component
 *
 * Displays findings grouped by type in flat sections (not accordion).
 * Section order: patterns, gaps, risks, then other types.
 */
export const AnalysisView = observer(function AnalysisView({
  feature,
}: AnalysisViewProps) {
  // Access platform-features domain for findings
  const { platformFeatures } = useDomains<{
    platformFeatures: {
      analysisFindingCollection: {
        findBySession: (sessionId: string) => Finding[]
      }
    }
  }>()

  // Fetch findings for this feature session
  const findings = platformFeatures?.analysisFindingCollection?.findBySession?.(feature.id) ?? []

  // Group findings by type
  const findingsByType = FINDING_TYPE_ORDER.reduce((acc, type) => {
    acc[type] = findings.filter((f: any) => f.type === type)
    return acc
  }, {} as Record<FindingType, Finding[]>)

  return (
    <div data-testid="analysis-view" className="space-y-6">
      {/* Summary */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Analysis Summary
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg">
          <p className="text-sm text-foreground">
            {findings.length === 0 ? (
              "No findings captured yet"
            ) : (
              `${findings.length} finding${findings.length !== 1 ? "s" : ""} across ${
                FINDING_TYPE_ORDER.filter(t => findingsByType[t].length > 0).length
              } categories`
            )}
          </p>
        </div>
      </section>

      {/* Findings by Type */}
      {findings.length === 0 ? (
        <section className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No findings captured yet. Run the analysis phase to discover patterns, gaps, and risks.
          </p>
        </section>
      ) : (
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
