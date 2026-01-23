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
 *
 * Config options:
 * - layout: "list" | "kanban" - Display mode (default: "list")
 * - groupBy: string - Field to group by (default: "priority")
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@shogo/app-core"
import { RequirementCard } from "@/components/app/shared"
import type { SectionRendererProps } from "../sectionImplementations"

/**
 * RequirementsListSection Component
 *
 * Displays requirements grouped by priority (must, should, could).
 * Fetches requirements from platformFeatures.requirementCollection using
 * the feature.id to filter by session.
 *
 * Supports both vertical list and horizontal kanban layouts via config.
 *
 * @param props - SectionRendererProps with feature and optional config
 */
export const RequirementsListSection = observer(function RequirementsListSection({
  feature,
  config,
}: SectionRendererProps) {
  // Access platform-features domain for requirements
  const { platformFeatures } = useDomains()

  // Extract config options
  const layout = config?.layout ?? "list"
  const groupBy = config?.groupBy ?? "priority"

  // Handle missing feature (e.g., in preview mode)
  if (!feature) {
    return (
      <section data-testid="requirements-list-section">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Requirements
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No feature session available
          </p>
        </div>
      </section>
    )
  }

  // Fetch requirements for this feature session
  const requirements =
    platformFeatures?.requirementCollection?.findBySession?.(feature.id) ?? []

  // Group requirements by the specified field
  const mustRequirements = requirements.filter(
    (req: any) => req[groupBy] === "must"
  )
  const shouldRequirements = requirements.filter(
    (req: any) => req[groupBy] === "should"
  )
  const couldRequirements = requirements.filter(
    (req: any) => req[groupBy] === "could"
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

  // Kanban layout - horizontal columns
  if (layout === "kanban") {
    return (
      <section data-testid="requirements-kanban-section" className="h-full overflow-hidden flex flex-col">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 px-4">
          Requirements ({requirements.length})
        </h3>

        <div className="flex-1 flex gap-4 overflow-x-auto px-4 pb-4">
          {/* Must Have Column */}
          <div className="flex-shrink-0 w-80 flex flex-col">
            <div className="mb-3 flex items-center gap-2 sticky top-0 bg-background pb-2">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <h4 className="text-sm font-medium text-red-600 dark:text-red-400">
                Must Have ({mustRequirements.length})
              </h4>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto" data-testid="kanban-column-must">
              {mustRequirements.map((req: any) => (
                <RequirementCard key={req.id} requirement={req} />
              ))}
            </div>
          </div>

          {/* Should Have Column */}
          <div className="flex-shrink-0 w-80 flex flex-col">
            <div className="mb-3 flex items-center gap-2 sticky top-0 bg-background pb-2">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <h4 className="text-sm font-medium text-amber-600 dark:text-amber-400">
                Should Have ({shouldRequirements.length})
              </h4>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto" data-testid="kanban-column-should">
              {shouldRequirements.map((req: any) => (
                <RequirementCard key={req.id} requirement={req} />
              ))}
            </div>
          </div>

          {/* Could Have Column */}
          <div className="flex-shrink-0 w-80 flex flex-col">
            <div className="mb-3 flex items-center gap-2 sticky top-0 bg-background pb-2">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              <h4 className="text-sm font-medium text-blue-600 dark:text-blue-400">
                Could Have ({couldRequirements.length})
              </h4>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto" data-testid="kanban-column-could">
              {couldRequirements.map((req: any) => (
                <RequirementCard key={req.id} requirement={req} />
              ))}
            </div>
          </div>
        </div>
      </section>
    )
  }

  // List layout - vertical stack (default)
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
