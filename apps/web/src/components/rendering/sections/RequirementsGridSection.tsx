/**
 * RequirementsGridSection
 * Task: Enhanced Discovery UI
 *
 * Grid layout of requirement cards with priority badges and status indicators.
 */

import type { SectionRendererProps } from "../sectionImplementations"

export function RequirementsGridSection({ feature, config }: SectionRendererProps) {
  const columns = (config?.columns as number) ?? 1
  const cardVariant = (config?.cardVariant as string) ?? "default"

  const requirements = feature.requirements ?? []

  const isElevatedNeon = cardVariant.includes("neon")

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-200">Requirements</h3>

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
                ? "bg-slate-900/80 border border-cyan-500/30 shadow-lg shadow-cyan-500/10 hover:shadow-cyan-500/20 transition-shadow"
                : "bg-slate-800 border border-slate-700"
            }`}
          >
            {/* Header with priority */}
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-200">{req.description}</div>
              </div>
              {req.priority && (
                <span
                  className={`px-2 py-0.5 text-xs font-semibold rounded ${
                    req.priority === "high"
                      ? "bg-red-500/20 text-red-300 border border-red-500/30"
                      : req.priority === "medium"
                      ? "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30"
                      : "bg-green-500/20 text-green-300 border border-green-500/30"
                  }`}
                >
                  {req.priority}
                </span>
              )}
            </div>

            {/* Status indicator */}
            {req.status && (
              <div className="mt-2 pt-2 border-t border-slate-700">
                <span className="text-xs text-slate-500">
                  Status: <span className="text-slate-400">{req.status}</span>
                </span>
              </div>
            )}

            {/* Rationale if present */}
            {req.rationale && (
              <div className="mt-2 text-xs text-slate-400">{req.rationale}</div>
            )}
          </div>
        ))}
      </div>

      {requirements.length === 0 && (
        <div className="text-center py-8 text-slate-500 text-sm">
          No requirements defined yet
        </div>
      )}
    </div>
  )
}
