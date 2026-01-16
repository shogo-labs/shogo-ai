/**
 * RequirementsGridSection
 * Task: Enhanced Discovery UI
 *
 * Grid layout of requirement cards with priority badges and status indicators.
 */

import type { SectionRendererProps } from "../sectionImplementations"
import { priorityBadgeVariants } from "../displays/domain/variants"

export function RequirementsGridSection({ feature, config }: SectionRendererProps) {
  const columns = (config?.columns as number) ?? 1
  const cardVariant = (config?.cardVariant as string) ?? "default"

  const requirements = feature.requirements ?? []

  const isElevatedNeon = cardVariant.includes("neon")

  // Map priority values to CVA variants (must/should/could)
  const getPriorityVariant = (p: string): "must" | "should" | "could" => {
    if (p === "high" || p === "must") return "must"
    if (p === "medium" || p === "should") return "should"
    return "could"
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Requirements</h3>

      <div
        className={`grid gap-3 ${
          columns === 2 ? "sm:grid-cols-2" : "grid-cols-1"
        }`}
      >
        {requirements.map((req: any, idx: number) => (
          <div
            key={req.id ?? idx}
            className={`rounded-lg p-4 ${
              isElevatedNeon
                ? "bg-card/80 backdrop-blur-sm border border-primary/30 shadow-lg shadow-primary/10 hover:shadow-primary/20 transition-shadow"
                : "bg-card border border-border"
            }`}
          >
            {/* Header with priority */}
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground">{req.description}</div>
              </div>
              {req.priority && (
                <span className={priorityBadgeVariants({ priority: getPriorityVariant(req.priority) })}>
                  {req.priority}
                </span>
              )}
            </div>

            {/* Status indicator */}
            {req.status && (
              <div className="mt-2 pt-2 border-t border-border">
                <span className="text-xs text-muted-foreground/70">
                  Status: <span className="text-muted-foreground">{req.status}</span>
                </span>
              </div>
            )}

            {/* Rationale if present */}
            {req.rationale && (
              <div className="mt-2 text-xs text-muted-foreground">{req.rationale}</div>
            )}
          </div>
        ))}
      </div>

      {requirements.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No requirements defined yet
        </div>
      )}
    </div>
  )
}
