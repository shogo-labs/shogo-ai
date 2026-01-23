/**
 * useFocusManagement Hook
 * Task: task-w3-keyboard-navigation
 *
 * Manages focus state, tabIndex (roving tabindex pattern), and focus ring styling.
 * Integrates with phase colors for consistent focus indicators.
 *
 * Features:
 * - Roving tabindex for composite widgets
 * - Phase-specific focus ring colors
 * - Focus return on close (for modals/panels)
 * - Focus visible detection
 */

import { useState, useCallback, useRef, useMemo } from "react"
import { usePhaseColor, type PhaseColors } from "./usePhaseColor"

/**
 * Item interface for focus management
 */
export interface FocusableItem {
  id: string
  label?: string
}

/**
 * Options for useFocusManagement hook
 */
export interface FocusManagementOptions {
  /** Enable roving tabindex pattern */
  rovingTabIndex?: boolean
  /** Items to manage focus for */
  items?: FocusableItem[]
  /** Currently focused item ID (controlled) */
  focusedId?: string | null
  /** Phase name for focus ring colors */
  phase?: string
  /** Whether to trap focus within component */
  trapFocus?: boolean
}

/**
 * Focus ring options
 */
export interface FocusRingOptions {
  /** Use focus-visible instead of focus */
  focusVisible?: boolean
  /** Include ring offset */
  withOffset?: boolean
  /** Custom ring width */
  ringWidth?: 1 | 2 | 4
}

/**
 * Return type for useFocusManagement hook
 */
export interface FocusManagementResult {
  /** Current focused ID (internal state) */
  focusedId: string | null
  /** Whether focus is trapped */
  trapFocus: boolean
  /** Set the focused ID */
  setFocusedId: (id: string | null) => void
  /** Get tabIndex for an item */
  getTabIndex: (id: string) => number
  /** Get focus ring class string */
  getFocusRingClass: (options?: FocusRingOptions) => string
  /** Set trigger element ref for focus return */
  setTriggerRef: (element: HTMLElement | null) => void
  /** Return focus to trigger element */
  returnFocusOnClose: () => void
  /** Phase colors being used */
  phaseColors: PhaseColors
}

/**
 * Phase to Tailwind ring color mapping
 */
const PHASE_RING_COLORS: Record<string, string> = {
  discovery: "ring-blue-500 dark:ring-blue-400",
  analysis: "ring-violet-500 dark:ring-violet-400",
  classification: "ring-pink-500 dark:ring-pink-400",
  design: "ring-amber-500 dark:ring-amber-400",
  spec: "ring-emerald-500 dark:ring-emerald-400",
  testing: "ring-cyan-500 dark:ring-cyan-400",
  implementation: "ring-red-500 dark:ring-red-400",
  complete: "ring-green-500 dark:ring-green-400",
}

/**
 * Hook for managing focus state and styling
 *
 * @example
 * ```tsx
 * const {
 *   getTabIndex,
 *   getFocusRingClass,
 *   setFocusedId
 * } = useFocusManagement({
 *   rovingTabIndex: true,
 *   items: [{ id: "1" }, { id: "2" }],
 *   phase: "design"
 * })
 *
 * return items.map(item => (
 *   <button
 *     key={item.id}
 *     tabIndex={getTabIndex(item.id)}
 *     className={getFocusRingClass({ focusVisible: true })}
 *     onFocus={() => setFocusedId(item.id)}
 *   >
 *     {item.label}
 *   </button>
 * ))
 * ```
 */
export function useFocusManagement(
  options: FocusManagementOptions = {}
): FocusManagementResult {
  const {
    rovingTabIndex = false,
    items = [],
    focusedId: controlledFocusedId,
    phase = "discovery",
    trapFocus = false,
  } = options

  // Internal focused state (for uncontrolled mode)
  const [internalFocusedId, setInternalFocusedId] = useState<string | null>(null)

  // Use controlled or uncontrolled focused ID
  const focusedId = controlledFocusedId !== undefined ? controlledFocusedId : internalFocusedId

  // Trigger element ref for focus return
  const triggerRef = useRef<HTMLElement | null>(null)

  // Get phase colors
  const phaseColors = usePhaseColor(phase)

  // Set focused ID
  const setFocusedId = useCallback((id: string | null) => {
    setInternalFocusedId(id)
  }, [])

  // Set trigger ref
  const setTriggerRef = useCallback((element: HTMLElement | null) => {
    triggerRef.current = element
  }, [])

  // Return focus to trigger element
  const returnFocusOnClose = useCallback(() => {
    if (triggerRef.current) {
      triggerRef.current.focus()
    }
  }, [])

  // Get tabIndex for roving tabindex pattern
  const getTabIndex = useCallback(
    (id: string): number => {
      if (!rovingTabIndex) return 0

      // If an item is focused, only that item gets tabIndex 0
      if (focusedId !== null) {
        return id === focusedId ? 0 : -1
      }

      // If no item focused, first item gets tabIndex 0
      const firstItem = items[0]
      if (firstItem && id === firstItem.id) {
        return 0
      }

      return -1
    },
    [rovingTabIndex, focusedId, items]
  )

  // Get focus ring class string
  const getFocusRingClass = useCallback(
    (ringOptions: FocusRingOptions = {}): string => {
      const {
        focusVisible = false,
        withOffset = true,
        ringWidth = 2,
      } = ringOptions

      // Get phase-specific ring color
      const ringColor = PHASE_RING_COLORS[phase] || PHASE_RING_COLORS.discovery

      // Build class string
      const classes: string[] = []

      // Ring width
      classes.push(`ring-${ringWidth}`)

      // Ring color
      classes.push(ringColor)

      // Ring offset for visibility against backgrounds
      if (withOffset) {
        classes.push("ring-offset-2")
        classes.push("ring-offset-background")
      }

      // Apply with focus-visible if requested
      if (focusVisible) {
        return classes.map((cls) => `focus-visible:${cls}`).join(" ")
      }

      return classes.join(" ")
    },
    [phase]
  )

  return {
    focusedId,
    trapFocus,
    setFocusedId,
    getTabIndex,
    getFocusRingClass,
    setTriggerRef,
    returnFocusOnClose,
    phaseColors,
  }
}
