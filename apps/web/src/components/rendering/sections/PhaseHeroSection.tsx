/**
 * PhaseHeroSection
 * Task: Enhanced Discovery UI
 *
 * Hero section displaying current phase with visual progress indicator and session name.
 * Supports dramatic styling variants and animated progress visualization.
 */

import type { SectionRendererProps } from "../sectionImplementations"

export function PhaseHeroSection({ feature, config }: SectionRendererProps) {
  const variant = (config?.variant as string) ?? "default"
  const showProgress = (config?.showProgress as boolean) ?? true
  const gradient = (config?.gradient as boolean) ?? false

  // Phase index mapping for progress
  const phases = [
    "discovery",
    "analysis",
    "classification",
    "design",
    "spec",
    "testing",
    "implementation",
    "complete",
  ]
  const currentPhaseIndex = phases.indexOf(feature.status)
  const progressPercentage = ((currentPhaseIndex + 1) / phases.length) * 100

  return (
    <div
      className={`relative overflow-hidden rounded-lg p-8 ${
        gradient
          ? "bg-gradient-to-br from-slate-900 via-purple-900/50 to-slate-900"
          : "bg-slate-900"
      }`}
    >
      {/* Background glow effect */}
      {variant === "dramatic" && (
        <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/10 via-purple-500/10 to-pink-500/10 animate-pulse" />
      )}

      <div className="relative z-10">
        {/* Phase badge */}
        <div className="inline-flex items-center gap-2 mb-3">
          <span className="px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
            {feature.status}
          </span>
          <span className="text-xs text-slate-400">Phase {currentPhaseIndex + 1} of {phases.length}</span>
        </div>

        {/* Session name */}
        <h1 className="text-3xl font-bold text-white mb-2">{feature.name}</h1>

        {/* Progress bar */}
        {showProgress && (
          <div className="mt-4">
            <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-purple-500 transition-all duration-500"
                style={{ width: `${progressPercentage}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
