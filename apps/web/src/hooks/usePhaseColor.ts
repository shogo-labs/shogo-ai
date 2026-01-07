/**
 * usePhaseColor Hook
 * Task: task-w1-use-phase-color-hook
 *
 * Returns phase-specific color tokens for a given phase string.
 * Used by all phase views to consistently apply phase-aware styling.
 */

import { useMemo } from "react"
import { phaseColorVariants, type PhaseType, PHASE_VALUES } from "@/components/rendering/displays/domain/variants"

/**
 * Color classes returned by the hook
 */
export interface PhaseColors {
  /** Background color class (e.g., "bg-blue-500 dark:bg-blue-400") */
  bg: string
  /** Text color class (e.g., "text-blue-500 dark:text-blue-400") */
  text: string
  /** Border color class (e.g., "border-blue-500 dark:border-blue-400") */
  border: string
  /** Ring/focus color class (e.g., "ring-blue-500 dark:ring-blue-400") */
  ring: string
  /** Default accent styling (bg + text for badges) */
  accent: string
}

/**
 * Neutral gray colors for unknown/invalid phases
 */
const NEUTRAL_COLORS: PhaseColors = {
  bg: "bg-gray-500 dark:bg-gray-400",
  text: "text-gray-500 dark:text-gray-400",
  border: "border-gray-500 dark:border-gray-400",
  ring: "ring-gray-500 dark:ring-gray-400",
  accent: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
}

/**
 * Check if a string is a valid phase value
 */
function isValidPhase(phase: string): phase is PhaseType {
  return PHASE_VALUES.includes(phase as PhaseType)
}

/**
 * Hook that returns phase-specific color tokens for styling
 *
 * @param phase - The phase name string
 * @returns Object with bg, text, border, ring, and accent color classes
 *
 * @example
 * ```tsx
 * function PhaseHeader({ phase }: { phase: string }) {
 *   const colors = usePhaseColor(phase)
 *
 *   return (
 *     <div className={cn("p-4 rounded-lg", colors.bg)}>
 *       <h2 className={colors.text}>{phase}</h2>
 *     </div>
 *   )
 * }
 * ```
 */
export function usePhaseColor(phase: string): PhaseColors {
  return useMemo(() => {
    // Return neutral colors for invalid/unknown phases
    if (!isValidPhase(phase)) {
      return NEUTRAL_COLORS
    }

    // Use phaseColorVariants to get consistent colors
    return {
      bg: phaseColorVariants({ phase, variant: "bg" }),
      text: phaseColorVariants({ phase, variant: "text" }),
      border: phaseColorVariants({ phase, variant: "border" }),
      ring: phaseColorVariants({ phase, variant: "ring" }),
      accent: phaseColorVariants({ phase, variant: "default" }),
    }
  }, [phase])
}

/**
 * Get phase colors without using a hook (for non-React contexts)
 *
 * @param phase - The phase name string
 * @returns Object with bg, text, border, ring, and accent color classes
 */
export function getPhaseColors(phase: string): PhaseColors {
  if (!isValidPhase(phase)) {
    return NEUTRAL_COLORS
  }

  return {
    bg: phaseColorVariants({ phase, variant: "bg" }),
    text: phaseColorVariants({ phase, variant: "text" }),
    border: phaseColorVariants({ phase, variant: "border" }),
    ring: phaseColorVariants({ phase, variant: "ring" }),
    accent: phaseColorVariants({ phase, variant: "default" }),
  }
}
