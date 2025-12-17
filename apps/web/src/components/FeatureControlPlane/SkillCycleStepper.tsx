/**
 * SkillCycleStepper - Horizontal stepper for skill cycle navigation
 *
 * Displays the 6 skill phases with visual indicators for:
 * - Current active step
 * - Completed steps
 * - Pending steps
 */

import { cn } from "@/lib/utils"

export type SkillPhase =
  | "discovery"
  | "analysis"
  | "classification"
  | "design"
  | "spec"
  | "implementation"

interface SkillCycleStepperProps {
  currentPhase: SkillPhase | null
  completedPhases: SkillPhase[]
  onPhaseClick?: (phase: SkillPhase) => void
}

const PHASES: { id: SkillPhase; label: string }[] = [
  { id: "discovery", label: "Discovery" },
  { id: "analysis", label: "Analysis" },
  { id: "classification", label: "Classification" },
  { id: "design", label: "Design" },
  { id: "spec", label: "Spec" },
  { id: "implementation", label: "Implementation" },
]

export function SkillCycleStepper({
  currentPhase,
  completedPhases,
  onPhaseClick,
}: SkillCycleStepperProps) {
  const getStepStatus = (phase: SkillPhase) => {
    if (completedPhases.includes(phase)) return "completed"
    if (phase === currentPhase) return "active"
    return "pending"
  }

  return (
    <div className="flex items-center justify-between w-full px-4 py-3 bg-card border-b border-border">
      {PHASES.map((phase, index) => {
        const status = getStepStatus(phase.id)
        const isLast = index === PHASES.length - 1

        return (
          <div key={phase.id} className="flex items-center flex-1">
            <button
              onClick={() => onPhaseClick?.(phase.id)}
              disabled={status === "pending"}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors",
                status === "completed" && "text-green-400 hover:bg-green-400/10",
                status === "active" && "text-blue-400 bg-blue-400/20",
                status === "pending" && "text-muted-foreground cursor-not-allowed"
              )}
            >
              <span
                className={cn(
                  "flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold",
                  status === "completed" && "bg-green-400 text-green-950",
                  status === "active" && "bg-blue-400 text-blue-950",
                  status === "pending" && "bg-muted text-muted-foreground"
                )}
              >
                {status === "completed" ? "✓" : index + 1}
              </span>
              <span className="text-sm font-medium">{phase.label}</span>
            </button>

            {!isLast && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-2",
                  completedPhases.includes(phase.id)
                    ? "bg-green-400"
                    : "bg-border"
                )}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
