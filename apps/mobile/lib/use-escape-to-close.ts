// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useEscapeToClose — web-only: calls `onClose` when Escape is pressed while
 * `visible`.
 *
 * The gluestack Modal accepts an `isKeyboardDismissable` prop, but nothing in
 * this build acts on it (`OverlayAnimatePresence` has no key handling), so
 * dialogs that look dismissable otherwise ignore the key. On native the
 * backdrop and the close button cover it.
 *
 * Extracted rather than inlined so the behaviour is testable on its own —
 * rendering the modal under RTL means pulling in Animated and the gesture
 * handlers the test preload deliberately leaves out.
 */
import { useEffect } from 'react'
import { Platform } from 'react-native'

export function useEscapeToClose(visible: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!visible || Platform.OS !== 'web' || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, visible])
}
