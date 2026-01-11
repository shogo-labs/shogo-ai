/**
 * SessionOverviewCard
 * Task: Enhanced Discovery UI
 *
 * Compact card showing session metadata: created date, updated date, affected packages count.
 */

import type { SectionRendererProps } from "../sectionImplementations"

export function SessionOverviewCard({ feature, config }: SectionRendererProps) {
  const layout = (config?.layout as string) ?? "vertical"
  const variant = (config?.variant as string) ?? "default"

  const createdDate = new Date(feature.createdAt).toLocaleDateString()
  const updatedDate = feature.updatedAt
    ? new Date(feature.updatedAt).toLocaleDateString()
    : "Never"
  const packagesCount = feature.affectedPackages?.length ?? 0

  const isGlass = variant.includes("glass")

  return (
    <div
      className={`rounded-lg p-4 ${
        isGlass
          ? "bg-white/5 backdrop-blur-sm border border-white/10"
          : "bg-slate-800 border border-slate-700"
      }`}
    >
      <h3 className="text-sm font-semibold text-slate-300 mb-3">Session Overview</h3>

      <div
        className={`space-y-2 ${
          layout === "horizontal" ? "sm:flex sm:gap-4 sm:space-y-0" : ""
        }`}
      >
        <div className="flex-1">
          <div className="text-xs text-slate-500 uppercase tracking-wide">Created</div>
          <div className="text-sm text-slate-200">{createdDate}</div>
        </div>

        <div className="flex-1">
          <div className="text-xs text-slate-500 uppercase tracking-wide">Updated</div>
          <div className="text-sm text-slate-200">{updatedDate}</div>
        </div>

        <div className="flex-1">
          <div className="text-xs text-slate-500 uppercase tracking-wide">Packages</div>
          <div className="text-sm text-slate-200">{packagesCount}</div>
        </div>
      </div>
    </div>
  )
}
