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
    <div className="rounded-lg bg-card border border-border overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">User Intent</h3>
        {expandable && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {isExpanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>

      {/* Content */}
      {isExpanded && (
        <div className="p-4 space-y-4">
          {/* Intent text */}
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <p className="text-muted-foreground leading-relaxed">{feature.intent}</p>
          </div>

          {/* Schema highlight */}
          <div className="flex items-center gap-2 pt-2 border-t border-border">
            <span className="text-xs text-muted-foreground/70">Schema:</span>
            <code className="px-2 py-1 text-xs font-mono bg-primary/10 text-primary rounded border border-primary/30">
              {schemaName}
            </code>
          </div>

          {/* Affected packages */}
          {showPackages && affectedPackages.length > 0 && (
            <div className="pt-2 border-t border-border">
              <div className="text-xs text-muted-foreground/70 mb-2">Affected Packages:</div>
              <div className="flex flex-wrap gap-2">
                {affectedPackages.map((pkg: string, idx: number) => (
                  <span
                    key={idx}
                    className="px-2 py-1 text-xs font-mono bg-muted text-foreground rounded border border-border"
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
