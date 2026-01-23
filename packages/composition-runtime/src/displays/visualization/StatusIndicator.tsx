/**
 * StatusIndicator Component
 * Task: task-w1-status-indicator-primitive
 *
 * A status indicator supporting:
 * - badge: Inline badge showing current status
 * - stepper: Progress stepper with visual stage progression
 *
 * Used for TDD cycle visualization, phase progression, and workflow status.
 */

import { memo } from "react"
import { cn } from "../../utils/cn"
import { Check } from "lucide-react"

/**
 * Stage definition
 */
export interface Stage {
  /** Unique stage identifier */
  id: string
  /** Display label */
  label: string
  /** Optional description */
  description?: string
}

/**
 * Layout types
 */
export type IndicatorLayout = "badge" | "stepper"

/**
 * Stage status (derived from position relative to currentStage)
 */
export type StageStatus = "completed" | "current" | "pending"

/**
 * StatusIndicator component props
 */
export interface StatusIndicatorProps {
  /** Array of stages */
  stages: Stage[]
  /** Current stage ID */
  currentStage: string
  /** Layout mode */
  layout?: IndicatorLayout
  /** Size variant */
  size?: "sm" | "md" | "lg"
  /** Additional CSS classes */
  className?: string
}

/**
 * Get stage status based on position relative to current stage
 */
function getStageStatus(
  stageIndex: number,
  currentIndex: number
): StageStatus {
  if (stageIndex < currentIndex) return "completed"
  if (stageIndex === currentIndex) return "current"
  return "pending"
}

/**
 * Badge layout component
 */
function BadgeLayout({
  stages,
  currentStage,
  size = "md",
  className,
}: StatusIndicatorProps) {
  const currentStageData = stages.find((s) => s.id === currentStage)
  const currentIndex = stages.findIndex((s) => s.id === currentStage)
  const totalStages = stages.length

  const sizeClasses = {
    sm: "text-xs px-2 py-0.5",
    md: "text-sm px-3 py-1",
    lg: "text-base px-4 py-1.5",
  }

  return (
    <div
      data-layout="badge"
      className={cn(
        "inline-flex items-center gap-2 rounded-full",
        "bg-primary/10 text-primary",
        "font-medium",
        sizeClasses[size],
        className
      )}
    >
      <span>{currentStageData?.label || currentStage}</span>
      <span className="text-muted-foreground">
        ({currentIndex + 1}/{totalStages})
      </span>
    </div>
  )
}

/**
 * Stepper layout component
 */
function StepperLayout({
  stages,
  currentStage,
  size = "md",
  className,
}: StatusIndicatorProps) {
  const currentIndex = stages.findIndex((s) => s.id === currentStage)

  const sizeConfig = {
    sm: { circle: "w-6 h-6", text: "text-xs", line: "h-0.5" },
    md: { circle: "w-8 h-8", text: "text-sm", line: "h-0.5" },
    lg: { circle: "w-10 h-10", text: "text-base", line: "h-1" },
  }

  const config = sizeConfig[size]

  return (
    <div
      data-layout="stepper"
      className={cn("flex items-center gap-2", className)}
    >
      {stages.map((stage, index) => {
        const status = getStageStatus(index, currentIndex)
        const isLast = index === stages.length - 1

        return (
          <div key={stage.id} className="flex items-center">
            {/* Stage circle */}
            <div
              data-stage={stage.id}
              data-status={status}
              className={cn(
                "relative flex items-center justify-center rounded-full",
                "transition-all duration-300",
                config.circle,
                status === "completed" && "bg-green-500 text-white",
                status === "current" && [
                  "bg-primary text-primary-foreground",
                  "ring-4 ring-primary/20",
                  "animate-pulse",
                ],
                status === "pending" && "bg-muted text-muted-foreground"
              )}
              title={stage.label}
            >
              {status === "completed" ? (
                <Check data-checkmark className="w-4 h-4" />
              ) : (
                <span className={cn("font-medium", config.text)}>
                  {index + 1}
                </span>
              )}
            </div>

            {/* Connector line */}
            {!isLast && (
              <div
                className={cn(
                  "w-8 mx-1",
                  config.line,
                  status === "completed" || status === "current"
                    ? "bg-green-500"
                    : "bg-muted"
                )}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * StatusIndicator component
 *
 * @example
 * ```tsx
 * // Simple badge
 * <StatusIndicator
 *   stages={[
 *     { id: "draft", label: "Draft" },
 *     { id: "review", label: "Review" },
 *     { id: "published", label: "Published" },
 *   ]}
 *   currentStage="review"
 *   layout="badge"
 * />
 *
 * // TDD cycle stepper
 * <StatusIndicator
 *   stages={[
 *     { id: "test_written", label: "Test Written" },
 *     { id: "test_failing", label: "Test Failing" },
 *     { id: "implementing", label: "Implementing" },
 *     { id: "test_passing", label: "Test Passing" },
 *   ]}
 *   currentStage="implementing"
 *   layout="stepper"
 * />
 * ```
 */
export const StatusIndicator = memo(function StatusIndicator(
  props: StatusIndicatorProps
) {
  const { layout = "stepper" } = props

  if (layout === "badge") {
    return <BadgeLayout {...props} />
  }

  return <StepperLayout {...props} />
})
