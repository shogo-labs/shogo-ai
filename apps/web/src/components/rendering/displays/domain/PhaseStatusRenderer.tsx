/**
 * PhaseStatusRenderer - Interactive domain renderer for phase status display
 * Task: task-cbe-002
 *
 * Renders phase nodes with registry-driven selection. Proves that renderers
 * can be interactive, not just display-only. Interactive behavior flows
 * through config.customProps.
 *
 * Key architectural insight: Renderers are just React components. Interactive
 * behavior (onClick, disabled, aria) flows through `config.customProps`.
 * This removes the artificial limitation that renderers must be "display only."
 *
 * Props via config.customProps:
 * - onClick: () => void - Click handler for navigation
 * - disabled: boolean - Whether the phase is blocked/inaccessible
 * - isCurrent: boolean - Whether this is the active phase
 * - isComplete: boolean - Whether this phase is complete
 * - ariaLabel: string - Accessibility label for the button
 */

import { observer } from "mobx-react-lite"
import { Check } from "lucide-react"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"
import type { DisplayRendererProps } from "../../types"

/**
 * CVA variants for phase node circle styling
 * Duplicated from PhaseNode.tsx to avoid circular dependency
 * (PhaseNode imports PropertyRenderer which imports implementations.ts)
 */
const phaseNodeVariants = cva(
  "flex items-center justify-center w-8 h-8 rounded-full border-2 transition-all",
  {
    variants: {
      status: {
        pending: "border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/50",
        current: "bg-primary border-primary text-primary-foreground shadow-md",
        complete: "bg-green-600 border-green-600 text-white",
        blocked: "bg-destructive/50 border-destructive/50 text-destructive-foreground/50 cursor-not-allowed",
      },
    },
    defaultVariants: {
      status: "pending",
    },
  }
)

/**
 * CVA variants for phase label text styling
 * Duplicated from PhaseNode.tsx to avoid circular dependency
 */
const labelVariants = cva("text-xs font-medium transition-colors", {
  variants: {
    status: {
      pending: "text-muted-foreground",
      current: "text-primary font-semibold",
      complete: "text-green-600",
      blocked: "text-destructive/50",
    },
  },
  defaultVariants: {
    status: "pending",
  },
})

/**
 * Custom props interface for PhaseStatusRenderer
 * Passed via config.customProps to enable interactive behavior
 */
interface PhaseStatusCustomProps {
  onClick?: () => void
  disabled?: boolean
  isCurrent?: boolean
  isComplete?: boolean
  ariaLabel?: string
}

/**
 * Determine the phase status based on custom props
 */
function getPhaseStatus(customProps: PhaseStatusCustomProps): "pending" | "current" | "complete" | "blocked" {
  if (customProps.isComplete) return "complete"
  if (customProps.isCurrent) return "current"
  if (customProps.disabled && !customProps.onClick) return "blocked"
  return "pending"
}

/**
 * Format phase name for display (capitalize first letter)
 */
function formatPhaseName(name: string): string {
  if (!name) return ""
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * PhaseStatusRenderer Component
 *
 * Interactive renderer for phase status display. Demonstrates that
 * registry-driven renderers can support full interactivity via customProps.
 */
export const PhaseStatusRenderer = observer(function PhaseStatusRenderer({
  value,
  config,
}: DisplayRendererProps) {
  // Handle null/undefined value
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const phaseName = String(value)
  const customProps = (config?.customProps ?? {}) as PhaseStatusCustomProps
  const {
    onClick,
    disabled = false,
    isCurrent = false,
    isComplete = false,
    ariaLabel,
  } = customProps

  const status = getPhaseStatus({ disabled, isCurrent, isComplete, onClick })
  const isBlocked = status === "blocked"
  const isClickable = onClick != null && !disabled

  // Generate default aria-label if not provided
  const effectiveAriaLabel = ariaLabel ?? `${formatPhaseName(phaseName)} phase - ${status}`

  const handleClick = () => {
    if (!disabled && onClick) {
      onClick()
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label={effectiveAriaLabel}
      aria-disabled={disabled}
      data-status={status}
      className={cn(
        "flex flex-col items-center gap-2",
        isClickable && "cursor-pointer",
        disabled && "cursor-not-allowed"
      )}
    >
      {/* Phase node circle with status styling */}
      <div
        data-phase-node
        className={cn(phaseNodeVariants({ status }))}
      >
        {isComplete && <Check className="w-4 h-4" />}
      </div>
      {/* Phase label text */}
      <span className={labelVariants({ status })}>
        {formatPhaseName(phaseName)}
      </span>
    </button>
  )
})

export default PhaseStatusRenderer
