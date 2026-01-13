/**
 * SessionSummarySection - Compact session metadata display
 * Task: task-cpv-009
 *
 * Shows compact session metadata suitable for sidebar or header area:
 * - Status badge with status-appropriate color
 * - Affected packages as tags/chips
 * - Applicable patterns as tags
 * - Schema name if present
 *
 * Uses the sessionStatusBadgeVariants from the domain variants for status coloring.
 */

import { observer } from "mobx-react-lite"
import { sessionStatusBadgeVariants } from "../displays/domain/variants"
import type { SectionRendererProps } from "../sectionImplementations"

type SessionStatus =
  | "discovery"
  | "analysis"
  | "classification"
  | "design"
  | "spec"
  | "testing"
  | "implementation"
  | "complete"

/**
 * Capitalizes the first letter of a string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * SessionSummarySection displays compact session metadata
 * suitable for sidebar placement.
 */
export const SessionSummarySection = observer(function SessionSummarySection({
  feature,
  config,
}: SectionRendererProps) {
  const status = (feature?.status ?? "discovery") as SessionStatus
  const affectedPackages = feature?.affectedPackages ?? []
  const applicablePatterns = feature?.applicablePatterns ?? []
  const schemaName = feature?.schemaName

  return (
    <div className="space-y-4" data-section="session-summary">
      {/* Status */}
      <div data-field="status">
        <h4
          className="text-sm font-medium text-muted-foreground mb-1"
          data-section-label
        >
          Status
        </h4>
        <span
          className={sessionStatusBadgeVariants({ status })}
          data-status-badge
        >
          {capitalize(status)}
        </span>
      </div>

      {/* Affected Packages */}
      <div data-field="packages">
        <h4
          className="text-sm font-medium text-muted-foreground mb-1"
          data-section-label
        >
          Packages
        </h4>
        <div className="flex flex-wrap gap-1" data-tag-container>
          {Array.isArray(affectedPackages) &&
            affectedPackages.map((pkg: string) => (
              <span
                key={pkg}
                className="text-xs bg-muted px-2 py-0.5 rounded"
                data-package-tag
              >
                {pkg}
              </span>
            ))}
        </div>
      </div>

      {/* Applicable Patterns */}
      <div data-field="patterns">
        <h4
          className="text-sm font-medium text-muted-foreground mb-1"
          data-section-label
        >
          Patterns
        </h4>
        <div className="flex flex-wrap gap-1" data-tag-container>
          {Array.isArray(applicablePatterns) &&
            applicablePatterns.map((pattern: string) => (
              <span
                key={pattern}
                className="text-xs bg-muted px-2 py-0.5 rounded"
                data-pattern-tag
              >
                {pattern}
              </span>
            ))}
        </div>
      </div>

      {/* Schema Name - only shown if present */}
      {schemaName && (
        <div data-field="schema">
          <h4
            className="text-sm font-medium text-muted-foreground mb-1"
            data-section-label
          >
            Schema
          </h4>
          <span className="text-sm text-foreground">{schemaName}</span>
        </div>
      )}
    </div>
  )
})
