/**
 * RequirementsListSection Component
 * Task: task-cpv-008
 *
 * Renders requirements grouped by priority (must/should/could) with priority badges.
 * Extracted from DiscoveryView for use as a composable section component.
 *
 * Uses useDomains() to access platformFeatures.requirementCollection and queries
 * requirements by the current feature session ID.
 *
 * Priority badge color coding:
 * - must: red/destructive
 * - should: amber/warning
 * - could: blue/info
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { RequirementCard } from "@/components/app/shared"
import type { SectionRendererProps } from "../sectionImplementations"

/**
 * RequirementsListSection Component
 *
 * Displays requirements grouped by priority (must, should, could).
 * Fetches requirements from platformFeatures.requirementCollection using
 * the feature.id to filter by session.
 *
 * @param props - SectionRendererProps with feature and optional config
 */
export const RequirementsListSection = observer(function RequirementsListSection({
  feature,
  config,
}: SectionRendererProps) {
  // Access platform-features domain for requirements
  const { platformFeatures } = useDomains()

  // Fetch requirements for this feature session
  const requirements =
    platformFeatures?.requirementCollection?.findBySession?.(feature.id) ?? []

  // Group requirements by priority
  const mustRequirements = requirements.filter(
    (req: any) => req.priority === "must"
  )
  const shouldRequirements = requirements.filter(
    (req: any) => req.priority === "should"
  )
  const couldRequirements = requirements.filter(
    (req: any) => req.priority === "could"
  )

  // Handle empty requirements list gracefully
  if (requirements.length === 0) {
    return (
      <section data-testid="requirements-list-section">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Requirements
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No requirements captured yet
          </p>
        </div>
      </section>
    )
  }

  return (
    <section data-testid="requirements-list-section">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Requirements ({requirements.length})
      </h3>

      <div className="space-y-4">
        {/* Must Have - Red */}
        {mustRequirements.length > 0 && (
          <div data-testid="requirements-must">
            <h4 className="text-sm font-medium text-red-600 dark:text-red-400 mb-2 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              Must Have ({mustRequirements.length})
            </h4>
            <div className="space-y-2">
              {mustRequirements.map((req: any) => (
                <RequirementCard key={req.id} requirement={req} />
              ))}
            </div>
          </div>
        )}

        {/* Should Have - Amber */}
        {shouldRequirements.length > 0 && (
          <div data-testid="requirements-should">
            <h4 className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              Should Have ({shouldRequirements.length})
            </h4>
            <div className="space-y-2">
              {shouldRequirements.map((req: any) => (
                <RequirementCard key={req.id} requirement={req} />
              ))}
            </div>
          </div>
        )}

        {/* Could Have - Blue */}
        {couldRequirements.length > 0 && (
          <div data-testid="requirements-could">
            <h4 className="text-sm font-medium text-blue-600 dark:text-blue-400 mb-2 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
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
    </section>
  )
})
