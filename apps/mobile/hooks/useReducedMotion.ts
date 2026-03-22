// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useReducedMotion Hook (React Native)
 *
 * Returns boolean for reduce-motion accessibility setting.
 * Uses react-native AccessibilityInfo API.
 */

import { useState, useEffect } from "react"
import { AccessibilityInfo } from "react-native"

export function useReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      setPrefersReducedMotion(enabled)
    })

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (enabled) => {
        setPrefersReducedMotion(enabled)
      }
    )

    return () => {
      subscription.remove()
    }
  }, [])

  return prefersReducedMotion
}

export default useReducedMotion
