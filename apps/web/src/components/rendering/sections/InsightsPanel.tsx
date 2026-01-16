/**
 * InsightsPanel
 * Task: Enhanced Discovery UI
 *
 * Sidebar panel showing initial assessment highlights, archetype, and key indicators.
 */

import type { SectionRendererProps } from "../sectionImplementations"
import { ArchetypeBadge, type FeatureArchetype } from "@/components/app/shared"
import { priorityBadgeVariants } from "../displays/domain/variants"

export function InsightsPanel({ feature, config }: SectionRendererProps) {
  const compact = (config?.compact as boolean) ?? false

  const archetype = feature.archetype ?? "domain"
  const priority = feature.priority ?? "could"
  // initialAssessment is an object with {likelyArchetype, indicators, uncertainties}
  const initialAssessment = feature.initialAssessment as { likelyArchetype?: string; indicators?: string[]; uncertainties?: string[] } | undefined

  // Map priority values to CVA variants (must/should/could)
  const getPriorityVariant = (p: string): "must" | "should" | "could" => {
    if (p === "high" || p === "must") return "must"
    if (p === "medium" || p === "should") return "should"
    return "could"
  }

  return (
    <div className="rounded-lg bg-card border border-border overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-muted/30 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Insights</h3>
      </div>

      {/* Content */}
      <div className={`p-4 space-y-4 ${compact ? "text-xs" : "text-sm"}`}>
        {/* Archetype */}
        <div>
          <div className="text-xs text-muted-foreground/70 uppercase tracking-wide mb-1">Archetype</div>
          <ArchetypeBadge archetype={archetype as FeatureArchetype} size="sm" />
        </div>

        {/* Priority */}
        <div>
          <div className="text-xs text-muted-foreground/70 uppercase tracking-wide mb-1">Priority</div>
          <span className={priorityBadgeVariants({ priority: getPriorityVariant(priority) })}>
            {priority}
          </span>
        </div>

        {/* Initial Assessment */}
        <div className="pt-3 border-t border-border">
          <div className="text-xs text-muted-foreground/70 uppercase tracking-wide mb-2">
            Initial Assessment
          </div>
          {initialAssessment ? (
            <div className="space-y-2">
              {initialAssessment.likelyArchetype && (
                <p className="text-muted-foreground">
                  <span className="text-muted-foreground/70">Archetype:</span> {initialAssessment.likelyArchetype}
                </p>
              )}
              {initialAssessment.indicators && initialAssessment.indicators.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  {initialAssessment.indicators.length} indicator(s) identified
                </p>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground italic">No assessment available</p>
          )}
        </div>

        {/* Key indicators */}
        <div className="pt-3 border-t border-border">
          <div className="text-xs text-muted-foreground/70 uppercase tracking-wide mb-2">
            Key Indicators
          </div>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Requirements</span>
              <span className="font-semibold text-foreground">
                {feature.requirements?.length ?? 0}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Tasks</span>
              <span className="font-semibold text-foreground">
                {feature.tasks?.length ?? 0}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
