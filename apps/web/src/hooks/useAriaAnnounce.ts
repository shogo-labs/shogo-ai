/**
 * useAriaAnnounce Hook
 * Task: task-w3-keyboard-navigation
 *
 * Provides screen reader announcements via aria-live regions.
 * Supports polite and assertive announcements with debouncing.
 *
 * Features:
 * - Polite announcements for non-urgent updates
 * - Assertive announcements for important changes
 * - Debouncing to prevent announcement spam
 * - Live region props for rendering
 */

import { useState, useCallback, useRef, useEffect } from "react"

/**
 * Options for useAriaAnnounce hook
 */
export interface AriaAnnounceOptions {
  /** Debounce delay in milliseconds */
  debounceMs?: number
  /** Default politeness level */
  defaultPoliteness?: "polite" | "assertive" | "off"
}

/**
 * Politeness level for announcements
 */
export type AriaPoliteness = "polite" | "assertive" | "off"

/**
 * Props for aria-live region element
 */
export interface LiveRegionProps {
  role: "status" | "alert"
  "aria-live": AriaPoliteness
  "aria-atomic": boolean
  className?: string
}

/**
 * Return type for useAriaAnnounce hook
 */
export interface AriaAnnounceResult {
  /** Make an announcement with specified politeness */
  announce: (message: string, politeness?: AriaPoliteness) => void
  /** Make a polite announcement */
  announcePolite: (message: string) => void
  /** Make an assertive announcement */
  announceAssertive: (message: string) => void
  /** Last announcement made */
  lastAnnouncement: string | null
  /** Politeness of last announcement */
  lastPoliteness: AriaPoliteness | null
  /** Pending announcement (during debounce) */
  pendingAnnouncement: string | null
  /** Get props for live region element */
  getLiveRegionProps: (politeness?: AriaPoliteness) => LiveRegionProps
  /** Current announcement to render in live region */
  currentAnnouncement: string
}

/**
 * Hook for screen reader announcements
 *
 * @example
 * ```tsx
 * const {
 *   announcePolite,
 *   getLiveRegionProps,
 *   currentAnnouncement
 * } = useAriaAnnounce()
 *
 * // Make announcement
 * announcePolite("Item selected")
 *
 * // Render live region (visually hidden)
 * return (
 *   <>
 *     <div {...getLiveRegionProps()} className="sr-only">
 *       {currentAnnouncement}
 *     </div>
 *     <YourContent />
 *   </>
 * )
 * ```
 */
export function useAriaAnnounce(
  options: AriaAnnounceOptions = {}
): AriaAnnounceResult {
  const {
    debounceMs = 0,
    defaultPoliteness = "polite",
  } = options

  // State
  const [lastAnnouncement, setLastAnnouncement] = useState<string | null>(null)
  const [lastPoliteness, setLastPoliteness] = useState<AriaPoliteness | null>(null)
  const [pendingAnnouncement, setPendingAnnouncement] = useState<string | null>(null)
  const [currentAnnouncement, setCurrentAnnouncement] = useState("")

  // Debounce timer ref
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  // Process announcement (after debounce)
  const processAnnouncement = useCallback(
    (message: string, politeness: AriaPoliteness) => {
      setLastAnnouncement(message)
      setLastPoliteness(politeness)
      setPendingAnnouncement(null)

      // Update current announcement for rendering
      // Clear first to ensure change is detected
      setCurrentAnnouncement("")
      // Use setTimeout to ensure the empty string renders first
      setTimeout(() => {
        setCurrentAnnouncement(message)
      }, 50)
    },
    []
  )

  // Make an announcement
  const announce = useCallback(
    (message: string, politeness: AriaPoliteness = defaultPoliteness) => {
      if (!message) return

      // If debouncing, update pending and reset timer
      if (debounceMs > 0) {
        setPendingAnnouncement(message)

        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
        }

        debounceTimerRef.current = setTimeout(() => {
          processAnnouncement(message, politeness)
        }, debounceMs)
      } else {
        // Immediate announcement
        processAnnouncement(message, politeness)
      }
    },
    [debounceMs, defaultPoliteness, processAnnouncement]
  )

  // Convenience methods
  const announcePolite = useCallback(
    (message: string) => announce(message, "polite"),
    [announce]
  )

  const announceAssertive = useCallback(
    (message: string) => announce(message, "assertive"),
    [announce]
  )

  // Get props for live region element
  const getLiveRegionProps = useCallback(
    (politeness: AriaPoliteness = defaultPoliteness): LiveRegionProps => ({
      role: politeness === "assertive" ? "alert" : "status",
      "aria-live": politeness,
      "aria-atomic": true,
      className: "sr-only",
    }),
    [defaultPoliteness]
  )

  return {
    announce,
    announcePolite,
    announceAssertive,
    lastAnnouncement,
    lastPoliteness,
    pendingAnnouncement,
    getLiveRegionProps,
    currentAnnouncement,
  }
}
