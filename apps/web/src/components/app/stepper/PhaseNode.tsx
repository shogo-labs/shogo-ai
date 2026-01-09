/**
 * PhaseNode Component
 * Task: task-cbe-008 (refactored from task-3-1-001)
 *
 * Single phase node in the SkillStepper with vertical stack layout.
 * Now uses PropertyRenderer with phase-status-renderer binding for
 * registry-driven rendering of interactive phase nodes.
 *
 * Key architectural proof: Interactive components work through registry
 * resolution via config.customProps. This demonstrates that renderers
 * are NOT "display only" - interactive behavior flows through customProps.
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

import { cva, type VariantProps } from "class-variance-authority"
import { PropertyRenderer, type PropertyMetadata } from "@/components/rendering"
import type { PhaseStatus } from "./phaseUtils"

/**
 * Phase color CSS variable mapping
 * Syncs stepper with sidebar phase colors
 */
const PHASE_COLOR_VAR: Record<string, string> = {
  discovery: "var(--phase-discovery)",
  analysis: "var(--phase-analysis)",
  classification: "var(--phase-classification)",
  design: "var(--phase-design)",
  spec: "var(--phase-spec)",
  testing: "var(--phase-testing)",
  implementation: "var(--phase-implementation)",
  complete: "var(--phase-complete)",
}

/**
 * CVA variants for PhaseNode circle styling
 *
 * Per design-3-1-001:
 * - 32px (w-8 h-8) circles for compact display
 * - pending: muted border/text, hover highlight
 * - current: primary bg/border, white text, shadow
 * - complete: green bg/border, white text, checkmark icon
 * - blocked: destructive/50 opacity, cursor-not-allowed
 *
 * Note: These variants are exported for use by PhaseStatusRenderer.
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
          // Uses --phase-color CSS variable set via inline style
          "shadow-md text-white",
          "hover:opacity-90",
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
 *
 * Note: These variants are exported for use by PhaseStatusRenderer.
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
 * PropertyMetadata for phase status rendering
 * Uses explicit xRenderer binding to resolve PhaseStatusRenderer via registry
 */
const phaseStatusMeta: PropertyMetadata = {
  name: "phaseStatus",
  type: "string",
  xRenderer: "phase-status-renderer"
}

/**
 * PhaseNode Component
 *
 * Per design-3-1-001:
 * Renders a vertical stack with 32px circle above full label text.
 * Circle shows checkmark for complete status.
 * Label text color coordinates with node status via labelVariants.
 *
 * Per task-cbe-008:
 * Uses PropertyRenderer with phase-status-renderer binding for
 * registry-driven rendering. Interactive behavior (onClick, disabled)
 * flows through config.customProps.
 */
export function PhaseNode({
  name,
  label,
  status,
  isSelected,
  onClick,
}: PhaseNodeProps) {
  // Status determination logic remains in PhaseNode parent
  const isBlocked = status === "blocked"
  const isComplete = status === "complete"
  const isCurrent = status === "current"

  // Get phase color for current status (syncs with sidebar)
  const phaseColor = PHASE_COLOR_VAR[name.toLowerCase()] ?? PHASE_COLOR_VAR.discovery

  // Handle click - prevent interaction when blocked
  const handleClick = () => {
    if (!isBlocked) {
      onClick()
    }
  }

  // Build config object with customProps for interactive behavior
  const config = {
    customProps: {
      onClick: handleClick,
      disabled: isBlocked,
      isCurrent,
      isComplete,
      ariaLabel: `${label} phase - ${status}`,
      // Pass additional props for styling
      phaseColor,
      isSelected,
    },
  }

  return (
    <div
      data-testid={`phase-node-${name}`}
      className="flex flex-col items-center"
    >
      <PropertyRenderer
        property={phaseStatusMeta}
        value={name}
        config={config}
      />
    </div>
  )
}
