/**
 * PhaseHeroSection
 * Task: Enhanced Discovery UI
 *
 * Hero section displaying current phase with visual progress indicator and session name.
 * Supports dramatic styling variants and animated progress visualization.
 */

import type { SectionRendererProps } from "../sectionImplementations"
import { usePhaseColorFromContext } from "./shared"
import { phaseColorVariants, type PhaseType } from "../displays/domain/variants"
import { cn } from "@/lib/utils"

export function PhaseHeroSection({ feature, config }: SectionRendererProps) {
  const variant = (config?.variant as string) ?? "default"
  const showProgress = (config?.showProgress as boolean) ?? true
  const gradient = (config?.gradient as boolean) ?? false

  const phaseColors = usePhaseColorFromContext()

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
  const currentPhase = (feature.status as PhaseType) ?? "discovery"

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg p-8",
        gradient
          ? "bg-gradient-to-br from-card via-primary/5 to-card"
          : "bg-card"
      )}
    >
      {/* Background glow effect */}
      {variant === "dramatic" && (
        <div className={cn(
          "absolute inset-0 animate-pulse opacity-10",
          phaseColors.bg
        )} />
      )}

      <div className="relative z-10">
        {/* Phase badge */}
        <div className="inline-flex items-center gap-2 mb-3">
          <span className={cn(
            "px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded-full",
            phaseColorVariants({ phase: currentPhase, variant: "default" })
          )}>
            {feature.status}
          </span>
          <span className="text-xs text-muted-foreground">Phase {currentPhaseIndex + 1} of {phases.length}</span>
        </div>

        {/* Session name */}
        <h1 className="text-3xl font-bold text-foreground mb-2">{feature.name}</h1>

        {/* Progress bar */}
        {showProgress && (
          <div className="mt-4">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={cn("h-full transition-all duration-500", phaseColors.bg)}
                style={{ width: `${progressPercentage}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
