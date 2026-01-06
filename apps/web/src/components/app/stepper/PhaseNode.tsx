/**
 * PhaseNode Component
 * Task: task-3-1-001 (redesign from task-2-3a-003)
 *
 * Single phase node in the SkillStepper with vertical stack layout.
 * 32px circle above full label text for visual clarity.
 *
 * Per design-3-1-001:
 * - Vertical stack: circle above full label text
 * - 32px circles with status-coordinated colors
 * - Label text color matches node status via labelVariants
 * - Checkmark icon inside complete nodes
 *
 * Per design-2-3a-clean-break:
 * - Built fresh in /components/app/stepper/
 * - Zero imports from /components/Studio/
 */

import { Check } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import type { PhaseStatus } from "./phaseUtils"

/**
 * CVA variants for PhaseNode circle styling
 *
 * Per design-3-1-001:
 * - 32px (w-8 h-8) circles for compact display
 * - pending: muted border/text, hover highlight
 * - current: primary bg/border, white text, shadow
 * - complete: green bg/border, white text, checkmark icon
 * - blocked: destructive/50 opacity, cursor-not-allowed
 */
export const phaseNodeVariants = cva(
  // Base styles - 32px circle
  "flex items-center justify-center w-8 h-8 rounded-full border-2 transition-all",
  {
    variants: {
      status: {
        pending: [
          "border-muted-foreground/30 bg-muted/30",
          "hover:bg-accent/50 hover:border-muted-foreground/50",
          "dark:border-muted-foreground/20 dark:bg-muted/20",
        ].join(" "),
        current: [
          "border-primary bg-primary shadow-md",
          "hover:bg-primary/90",
          "dark:bg-primary dark:border-primary",
        ].join(" "),
        complete: [
          "border-green-500 bg-green-500 text-white",
          "hover:bg-green-600 hover:border-green-600",
          "dark:bg-green-600 dark:border-green-600",
        ].join(" "),
        blocked: [
          "border-destructive/50 bg-destructive/20 opacity-50",
          "dark:bg-destructive/10 dark:border-destructive/30",
        ].join(" "),
      },
    },
    defaultVariants: {
      status: "pending",
    },
  }
)

/**
 * CVA variants for label text color coordination
 *
 * Per design-3-1-001:
 * - Label text color matches node status
 * - Provides visual consistency between node and label
 */
export const labelVariants = cva(
  // Base styles
  "text-xs font-medium text-center whitespace-nowrap transition-colors",
  {
    variants: {
      status: {
        pending: "text-muted-foreground",
        current: "text-primary font-semibold",
        complete: "text-green-600 dark:text-green-500",
        blocked: "text-destructive/50",
      },
    },
    defaultVariants: {
      status: "pending",
    },
  }
)

/**
 * Props for PhaseNode component
 */
export interface PhaseNodeProps extends VariantProps<typeof phaseNodeVariants> {
  /** Phase name (e.g., 'discovery', 'design') */
  name: string
  /** Display label for the phase */
  label: string
  /** Phase status determining visual style */
  status: PhaseStatus
  /** Whether this node is currently selected */
  isSelected: boolean
  /** Callback when node is clicked */
  onClick: () => void
}

/**
 * PhaseNode Component
 *
 * Per design-3-1-001:
 * Renders a vertical stack with 32px circle above full label text.
 * Circle shows checkmark for complete status.
 * Label text color coordinates with node status via labelVariants.
 */
export function PhaseNode({
  name,
  label,
  status,
  isSelected,
  onClick,
}: PhaseNodeProps) {
  const isBlocked = status === "blocked"
  const isComplete = status === "complete"

  const handleClick = () => {
    if (!isBlocked) {
      onClick()
    }
  }

  return (
    <button
      type="button"
      role="button"
      onClick={handleClick}
      disabled={isBlocked}
      aria-selected={isSelected}
      aria-disabled={isBlocked}
      aria-label={`${label} phase - ${status}`}
      data-testid={`phase-node-${name}`}
      className={cn(
        // Vertical flex-col layout: circle above label
        "flex flex-col items-center gap-2 cursor-pointer",
        isBlocked && "cursor-not-allowed"
      )}
    >
      {/* 32px circle with status styling */}
      <div
        className={cn(
          phaseNodeVariants({ status }),
          // Selected state ring (independent of status)
          isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background"
        )}
      >
        {isComplete && <Check className="w-4 h-4" />}
      </div>
      {/* Full label text below circle */}
      <span className={labelVariants({ status })}>
        {label}
      </span>
    </button>
  )
}
