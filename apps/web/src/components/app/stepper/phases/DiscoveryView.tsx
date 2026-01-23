/**
 * DiscoveryView Component
 * Task: task-2-3b-007
 *
 * Displays the Discovery phase content: intent, initial assessment, and requirements list.
 *
 * Props:
 * - feature: FeatureForPanel with id, name, status, intent, initialAssessment
 *
 * Per design-2-3b-component-hierarchy:
 * - Built in /components/app/stepper/phases/
 * - Uses useDomains() for data access
 * - Wrapped with observer() for MobX reactivity
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@shogo/app-core"
import { cn } from "@/lib/utils"
import {
  RequirementCard,
  ArchetypeBadge,
  type Requirement,
  type FeatureArchetype,
} from "../../shared"

/**
 * Extended feature type for DiscoveryView
 */
export interface DiscoveryFeature {
  id: string
  name: string
  status: string
  intent?: string
  initialAssessment?: {
    likelyArchetype?: FeatureArchetype
    indicators?: string[]
    uncertainties?: string[]
  }
}

/**
 * Props for DiscoveryView component
 */
export interface DiscoveryViewProps {
  /** Feature session to display */
  feature: DiscoveryFeature
}

/**
 * DiscoveryView Component
 *
 * Displays:
 * 1. Feature intent as primary content block
 * 2. Initial assessment section with archetype, indicators, uncertainties
 * 3. Requirements grouped by priority (must, should, could)
 */
export const DiscoveryView = observer(function DiscoveryView({
  feature,
}: DiscoveryViewProps) {
  // Access platform-features domain for requirements
  const { platformFeatures } = useDomains()

  // Fetch requirements for this feature session
  const requirements = platformFeatures?.requirementCollection?.findBySession?.(feature.id) ?? []

  // Group requirements by priority
  const mustRequirements = requirements.filter((r: any) => r.priority === "must")
  const shouldRequirements = requirements.filter((r: any) => r.priority === "should")
  const couldRequirements = requirements.filter((r: any) => r.priority === "could")

  const { initialAssessment } = feature

  return (
    <div data-testid="discovery-view" className="space-y-6">
      {/* Intent Section */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Intent
        </h3>
        <div className="p-4 bg-muted/50 rounded-lg">
          <p className="text-foreground whitespace-pre-wrap">
            {feature.intent || "No intent specified"}
          </p>
        </div>
      </section>

      {/* Initial Assessment Section (conditional) */}
      {initialAssessment && (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Initial Assessment
          </h3>
          <div className="p-4 bg-muted/30 rounded-lg space-y-4">
            {/* Likely Archetype */}
            {initialAssessment.likelyArchetype && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Likely Archetype:</span>
                <ArchetypeBadge archetype={initialAssessment.likelyArchetype} size="md" />
              </div>
            )}

            {/* Indicators */}
            {initialAssessment.indicators && initialAssessment.indicators.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-foreground mb-2">Indicators</h4>
                <ul className="list-disc list-inside space-y-1">
                  {initialAssessment.indicators.map((indicator, index) => (
                    <li key={index} className="text-sm text-muted-foreground">
                      {indicator}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Uncertainties */}
            {initialAssessment.uncertainties && initialAssessment.uncertainties.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-foreground mb-2">Uncertainties</h4>
                <ul className="list-disc list-inside space-y-1">
                  {initialAssessment.uncertainties.map((uncertainty, index) => (
                    <li key={index} className="text-sm text-muted-foreground">
                      {uncertainty}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Requirements Section */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Requirements ({requirements.length})
        </h3>

        {requirements.length === 0 ? (
          <div className="p-4 bg-muted/30 rounded-lg text-center">
            <p className="text-sm text-muted-foreground">
              No requirements captured yet
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Must Have */}
            {mustRequirements.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-red-600 dark:text-red-400 mb-2">
                  Must Have ({mustRequirements.length})
                </h4>
                <div className="space-y-2">
                  {mustRequirements.map((req: any) => (
                    <RequirementCard key={req.id} requirement={req} />
                  ))}
                </div>
              </div>
            )}

            {/* Should Have */}
            {shouldRequirements.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-2">
                  Should Have ({shouldRequirements.length})
                </h4>
                <div className="space-y-2">
                  {shouldRequirements.map((req: any) => (
                    <RequirementCard key={req.id} requirement={req} />
                  ))}
                </div>
              </div>
            )}

            {/* Could Have */}
            {couldRequirements.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-blue-600 dark:text-blue-400 mb-2">
                  Could Have ({couldRequirements.length})
                </h4>
                <div className="space-y-2">
                  {couldRequirements.map((req: any) => (
                    <RequirementCard key={req.id} requirement={req} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
})
