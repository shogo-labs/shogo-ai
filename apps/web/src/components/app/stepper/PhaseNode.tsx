/**
 * PhaseNode Component
 * Task: task-2-3a-003
 *
 * Single phase node in the SkillStepper with CVA status variants.
 * Supports pending, current, complete, blocked statuses.
 *
 * Per design-2-3a-cva-variants:
 * - Four status variants with distinct visual styles
 * - Ring-2 ring-primary for selected state overlay
 * - Dark mode handled via dark: prefix classes
 *
 * Per finding-2-3a-003:
 * - Follows CVA pattern from FeatureItem.tsx
 *
 * Per design-2-3a-clean-break:
 * - Built fresh in /components/app/stepper/
 * - Zero imports from /components/Studio/
 */

import { CheckCircle } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import type { PhaseStatus } from "./phaseUtils"

/**
 * CVA variants for PhaseNode status styling
 *
 * Per design-2-3a-cva-variants:
 * - pending: muted border/text, hover highlight
 * - current: primary bg/border, white text, shadow
 * - complete: green bg/border, white text, checkmark icon
 * - blocked: destructive/50 opacity, cursor-not-allowed
 */
export const phaseNodeVariants = cva(
  // Base styles
  "flex items-center justify-center w-10 h-10 rounded-full border-2 transition-all text-xs font-medium cursor-pointer",
  {
    variants: {
      status: {
        pending: [
          "border-muted-foreground/30 text-muted-foreground bg-muted/30",
          "hover:bg-accent/50 hover:border-muted-foreground/50",
          "dark:border-muted-foreground/20 dark:bg-muted/20",
        ].join(" "),
        current: [
          "border-primary bg-primary text-primary-foreground shadow-md",
          "hover:bg-primary/90",
          "dark:bg-primary dark:border-primary",
        ].join(" "),
        complete: [
          "border-green-500 bg-green-500 text-white",
          "hover:bg-green-600 hover:border-green-600",
          "dark:bg-green-600 dark:border-green-600",
        ].join(" "),
        blocked: [
          "border-destructive/50 bg-destructive/20 text-destructive opacity-50 cursor-not-allowed",
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
 * Renders a single phase node with status-based styling.
 * Shows short label text, with CheckCircle icon for complete status.
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
        phaseNodeVariants({ status }),
        // Selected state ring (independent of status)
        isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background"
      )}
      title={label}
    >
      {isComplete ? (
        <CheckCircle className="w-5 h-5" />
      ) : (
        <span className="truncate px-1">{label.slice(0, 4)}</span>
      )}
    </button>
  )
}
