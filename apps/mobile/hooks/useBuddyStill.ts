// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whether the Shogo buddy should draw one frame and hold it (SHO-600).
 *
 * On the phone the buddy is a WKWebView that keeps its own WebContent process
 * drawing for as long as the document says it is visible — including while its
 * screen is buried under another one, and after the app has gone to the
 * background. WKWebView's `visibilitychange` does not fire for either, so the
 * host tells it: `still` while the screen is not on top, while the app is not
 * in the foreground, and whenever Reduce Motion is on.
 */
import { useEffect, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import * as ExpoRouter from 'expo-router'
import { useReducedMotion } from './useReducedMotion'

/**
 * Resolved once, so a renderer without a navigator (a bare test, a preview
 * pane) treats itself as focused instead of throwing.
 */
const useIsFocused: () => boolean =
  (ExpoRouter as { useIsFocused?: () => boolean }).useIsFocused ?? (() => true)

function useAppActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState === 'active')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) =>
      setActive(next === 'active'),
    )
    return () => subscription.remove()
  }, [])
  return active
}

/** True when the buddy must not animate: off-screen, backgrounded, or reduced motion. */
export function useBuddyStill(): boolean {
  const focused = useIsFocused()
  const active = useAppActive()
  const reduceMotion = useReducedMotion()
  return !focused || !active || reduceMotion
}
