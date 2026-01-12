/**
 * ContextFooter
 * Task: Enhanced Discovery UI
 *
 * Footer showing applicable patterns, uncertainties, and additional context.
 */

import type { SectionRendererProps } from "../sectionImplementations"

export function ContextFooter({ feature, config }: SectionRendererProps) {
  const layout = (config?.layout as string) ?? "default"

  const applicablePatterns = feature.applicablePatterns ?? []
  const uncertainties = feature.uncertainties ?? []

  // If both are empty, show nothing
  if (applicablePatterns.length === 0 && uncertainties.length === 0) {
    return null
  }

  return (
    <div className="rounded-lg bg-slate-800 border border-slate-700 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-900/50 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200">Context</h3>
      </div>

      {/* Content */}
      <div className={`p-4 space-y-4 ${layout === "tabbed" ? "" : ""}`}>
        {/* Applicable Patterns */}
        {applicablePatterns.length > 0 && (
          <div>
            <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">
              Applicable Patterns
            </div>
            <div className="flex flex-wrap gap-2">
              {applicablePatterns.map((pattern: string, idx: number) => (
                <span
                  key={idx}
                  className="px-2 py-1 text-xs bg-purple-500/20 text-purple-300 rounded border border-purple-500/30"
                >
                  {pattern}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Uncertainties */}
        {uncertainties.length > 0 && (
          <div className={applicablePatterns.length > 0 ? "pt-3 border-t border-slate-700" : ""}>
            <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">
              Uncertainties
            </div>
            <ul className="space-y-1">
              {uncertainties.map((uncertainty: string, idx: number) => (
                <li key={idx} className="text-sm text-slate-400 flex items-start gap-2">
                  <span className="text-orange-400 mt-0.5">•</span>
                  <span>{uncertainty}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
