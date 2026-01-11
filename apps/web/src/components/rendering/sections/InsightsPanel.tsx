/**
 * InsightsPanel
 * Task: Enhanced Discovery UI
 *
 * Sidebar panel showing initial assessment highlights, archetype, and key indicators.
 */

import type { SectionRendererProps } from "../sectionImplementations"

export function InsightsPanel({ feature, config }: SectionRendererProps) {
  const variant = (config?.variant as string) ?? "default"
  const compact = (config?.compact as boolean) ?? false

  const archetype = feature.archetype ?? "unknown"
  const priority = feature.priority ?? "medium"
  // initialAssessment is an object with {likelyArchetype, indicators, uncertainties}
  const initialAssessment = feature.initialAssessment as { likelyArchetype?: string; indicators?: string[]; uncertainties?: string[] } | undefined

  return (
    <div className="rounded-lg bg-slate-800 border border-slate-700 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-900/50 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200">Insights</h3>
      </div>

      {/* Content */}
      <div className={`p-4 space-y-4 ${compact ? "text-xs" : "text-sm"}`}>
        {/* Archetype */}
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Archetype</div>
          <span
            className={`inline-block px-2 py-1 text-xs font-semibold rounded ${
              archetype === "enhancement"
                ? "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                : archetype === "new-feature"
                ? "bg-green-500/20 text-green-300 border border-green-500/30"
                : archetype === "bug-fix"
                ? "bg-red-500/20 text-red-300 border border-red-500/30"
                : "bg-slate-500/20 text-slate-300 border border-slate-500/30"
            }`}
          >
            {archetype}
          </span>
        </div>

        {/* Priority */}
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Priority</div>
          <span
            className={`inline-block px-2 py-1 text-xs font-semibold rounded ${
              priority === "high"
                ? "bg-red-500/20 text-red-300 border border-red-500/30"
                : priority === "medium"
                ? "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30"
                : "bg-green-500/20 text-green-300 border border-green-500/30"
            }`}
          >
            {priority}
          </span>
        </div>

        {/* Initial Assessment */}
        <div className="pt-3 border-t border-slate-700">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">
            Initial Assessment
          </div>
          {initialAssessment ? (
            <div className="space-y-2">
              {initialAssessment.likelyArchetype && (
                <p className="text-slate-300">
                  <span className="text-slate-500">Archetype:</span> {initialAssessment.likelyArchetype}
                </p>
              )}
              {initialAssessment.indicators && initialAssessment.indicators.length > 0 && (
                <p className="text-slate-400 text-xs">
                  {initialAssessment.indicators.length} indicator(s) identified
                </p>
              )}
            </div>
          ) : (
            <p className="text-slate-400 italic">No assessment available</p>
          )}
        </div>

        {/* Key indicators */}
        <div className="pt-3 border-t border-slate-700">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">
            Key Indicators
          </div>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Requirements</span>
              <span className="font-semibold text-slate-200">
                {feature.requirements?.length ?? 0}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Tasks</span>
              <span className="font-semibold text-slate-200">
                {feature.tasks?.length ?? 0}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
