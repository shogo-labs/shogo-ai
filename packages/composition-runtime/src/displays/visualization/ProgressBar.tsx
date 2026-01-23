/**
 * ProgressBar Component
 * Task: task-w1-progress-bar-primitive
 *
 * A flexible progress bar component supporting multiple variants:
 * - horizontal: Standard horizontal progress bar
 * - vertical: Vertical progress bar
 * - stacked: Multi-segment stacked bar
 * - confidence: Progress bar with percentage label
 */

import { memo } from "react"
import { cn } from "../../utils/cn"
import { phaseColorVariants, type PhaseType } from "../../utils/variants"

/**
 * Segment data for stacked progress bar
 */
export interface ProgressSegment {
  value: number
  color: string
  label?: string
}

/**
 * ProgressBar component props
 */
export interface ProgressBarProps {
  /** Current value (for non-stacked variants) */
  value?: number
  /** Maximum value (default: 100) */
  max?: number
  /** Variant type */
  variant?: "horizontal" | "vertical" | "stacked" | "confidence"
  /** Segments for stacked variant */
  segments?: ProgressSegment[]
  /** Phase for phase-colored styling */
  phase?: PhaseType
  /** Additional CSS classes */
  className?: string
  /** Height for horizontal variant (default: 8px) */
  height?: number
  /** Width for vertical variant (default: 8px) */
  width?: number
  /** Show label for confidence variant */
  showLabel?: boolean
  /** Accessible label */
  ariaLabel?: string
}

/**
 * Get color class based on phase
 */
function getPhaseColorClass(phase: PhaseType | undefined): string {
  if (!phase) return "bg-primary"
  return phaseColorVariants({ phase, variant: "bg" })
}

/**
 * Horizontal progress bar (default)
 */
function HorizontalBar({
  value,
  max,
  phase,
  height = 8,
  className,
  ariaLabel,
}: ProgressBarProps) {
  const percentage = max ? Math.min(100, (value! / max) * 100) : value!

  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={ariaLabel || "Progress"}
      className={cn("w-full bg-muted rounded-full overflow-hidden", className)}
      style={{ height: `${height}px` }}
    >
      <div
        className={cn("h-full rounded-full transition-all duration-300", getPhaseColorClass(phase))}
        style={{ width: `${percentage}%` }}
      />
    </div>
  )
}

/**
 * Vertical progress bar
 */
function VerticalBar({
  value,
  max,
  phase,
  width = 8,
  className,
  ariaLabel,
}: ProgressBarProps) {
  const percentage = max ? Math.min(100, (value! / max) * 100) : value!

  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={ariaLabel || "Progress"}
      className={cn("h-full bg-muted rounded-full overflow-hidden flex flex-col-reverse", className)}
      style={{ width: `${width}px` }}
    >
      <div
        className={cn("w-full rounded-full transition-all duration-300", getPhaseColorClass(phase))}
        style={{ height: `${percentage}%` }}
      />
    </div>
  )
}

/**
 * Stacked multi-segment progress bar
 */
function StackedBar({
  segments = [],
  height = 8,
  className,
  ariaLabel,
}: ProgressBarProps) {
  const total = segments.reduce((sum, seg) => sum + seg.value, 0)

  return (
    <div
      role="progressbar"
      aria-valuenow={total}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel || "Stacked progress"}
      className={cn("w-full bg-muted rounded-full overflow-hidden flex", className)}
      style={{ height: `${height}px` }}
    >
      {segments.map((segment, index) => (
        <div
          key={index}
          data-segment={segment.label || index}
          className="h-full transition-all duration-300"
          style={{
            width: `${segment.value}%`,
            backgroundColor: segment.color,
          }}
          title={segment.label ? `${segment.label}: ${segment.value}%` : `${segment.value}%`}
        />
      ))}
    </div>
  )
}

/**
 * Confidence bar with percentage label
 */
function ConfidenceBar({
  value,
  max = 100,
  phase,
  height = 8,
  className,
  showLabel = true,
  ariaLabel,
}: ProgressBarProps) {
  const percentage = Math.round((value! / max) * 100)

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={ariaLabel || "Confidence"}
        className="flex-1 bg-muted rounded-full overflow-hidden"
        style={{ height: `${height}px` }}
      >
        <div
          className={cn("h-full rounded-full transition-all duration-300", getPhaseColorClass(phase))}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-sm font-medium text-muted-foreground min-w-[3ch] text-right">
          {percentage}%
        </span>
      )}
    </div>
  )
}

/**
 * ProgressBar component
 *
 * @example
 * ```tsx
 * // Simple horizontal progress
 * <ProgressBar value={75} max={100} />
 *
 * // Phase-colored progress
 * <ProgressBar value={50} phase="discovery" />
 *
 * // Stacked segments
 * <ProgressBar
 *   variant="stacked"
 *   segments={[
 *     { value: 70, color: "#3b82f6", label: "Unit" },
 *     { value: 20, color: "#8b5cf6", label: "Integration" },
 *     { value: 10, color: "#22c55e", label: "Acceptance" },
 *   ]}
 * />
 *
 * // Confidence bar with label
 * <ProgressBar value={85} variant="confidence" phase="classification" />
 * ```
 */
export const ProgressBar = memo(function ProgressBar(props: ProgressBarProps) {
  const { variant = "horizontal", value = 0, max = 100 } = props

  switch (variant) {
    case "vertical":
      return <VerticalBar {...props} value={value} max={max} />
    case "stacked":
      return <StackedBar {...props} />
    case "confidence":
      return <ConfidenceBar {...props} value={value} max={max} />
    case "horizontal":
    default:
      return <HorizontalBar {...props} value={value} max={max} />
  }
})
