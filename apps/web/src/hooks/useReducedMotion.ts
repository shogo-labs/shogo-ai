/**
 * useReducedMotion Hook
 * Task: task-chat-002
 *
 * Returns boolean for prefers-reduced-motion media query.
 * Used by JS-controlled animations to respect user preferences.
 *
 * @returns boolean - true if user prefers reduced motion
 *
 * @example
 * ```tsx
 * function AnimatedComponent() {
 *   const prefersReducedMotion = useReducedMotion()
 *
 *   return (
 *     <div className={prefersReducedMotion ? "opacity-100" : "animate-fade-in"}>
 *       Content
 *     </div>
 *   )
 * }
 * ```
 */

import { useState, useEffect } from "react"

const QUERY = "(prefers-reduced-motion: reduce)"

/**
 * Hook that returns whether the user prefers reduced motion.
 * Listens for changes via matchMedia event listener.
 *
 * @returns boolean - true if user prefers reduced motion, false otherwise
 */
export function useReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() => {
    // SSR safety: check for window
    if (typeof window === "undefined") {
      return false
    }
    return window.matchMedia(QUERY).matches
  })

  useEffect(() => {
    // SSR safety: check for window
    if (typeof window === "undefined") {
      return
    }

    const mediaQueryList = window.matchMedia(QUERY)

    // Event handler for media query changes
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches)
    }

    // Modern API: addEventListener
    mediaQueryList.addEventListener("change", handleChange)

    // Cleanup: remove event listener on unmount
    return () => {
      mediaQueryList.removeEventListener("change", handleChange)
    }
  }, [])

  return prefersReducedMotion
}

export default useReducedMotion
