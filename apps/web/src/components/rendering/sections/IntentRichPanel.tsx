/**
 * IntentRichPanel
 * Task: Enhanced Discovery UI
 *
 * Enhanced intent display with formatting, affected packages list, and schema name highlight.
 */

import { useState } from "react"
import type { SectionRendererProps } from "../sectionImplementations"

export function IntentRichPanel({ feature, config }: SectionRendererProps) {
  const expandable = (config?.expandable as boolean) ?? false
  const showPackages = (config?.showPackages as boolean) ?? true
  const [isExpanded, setIsExpanded] = useState(true)

  const affectedPackages = feature.affectedPackages ?? []
  const schemaName = feature.schemaName ?? "N/A"

  return (
    <div className="rounded-lg bg-slate-800 border border-slate-700 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-900/50 border-b border-slate-700 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">User Intent</h3>
        {expandable && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            {isExpanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>

      {/* Content */}
      {isExpanded && (
        <div className="p-4 space-y-4">
          {/* Intent text */}
          <div className="prose prose-invert prose-sm max-w-none">
            <p className="text-slate-300 leading-relaxed">{feature.intent}</p>
          </div>

          {/* Schema highlight */}
          <div className="flex items-center gap-2 pt-2 border-t border-slate-700">
            <span className="text-xs text-slate-500">Schema:</span>
            <code className="px-2 py-1 text-xs font-mono bg-purple-500/20 text-purple-300 rounded border border-purple-500/30">
              {schemaName}
            </code>
          </div>

          {/* Affected packages */}
          {showPackages && affectedPackages.length > 0 && (
            <div className="pt-2 border-t border-slate-700">
              <div className="text-xs text-slate-500 mb-2">Affected Packages:</div>
              <div className="flex flex-wrap gap-2">
                {affectedPackages.map((pkg: string, idx: number) => (
                  <span
                    key={idx}
                    className="px-2 py-1 text-xs font-mono bg-cyan-500/20 text-cyan-300 rounded border border-cyan-500/30"
                  >
                    {pkg}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
