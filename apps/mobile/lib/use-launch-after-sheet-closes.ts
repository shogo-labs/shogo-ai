// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useRef } from "react"

/**
 * iOS will not present a picker (PHPicker / UIDocumentPicker) on a view
 * controller that is still dismissing a `<Modal>`: the request is dropped
 * without an error, so the promise never settles and the tap looks dead
 * (SHO-283). Close the sheet first, then launch from the Modal's `onDismiss`.
 *
 * `onDismiss` is iOS-only, so a short fallback timer covers Android and any
 * version that never fires it. Whichever arrives first wins, and the action
 * runs exactly once.
 */
export const SHEET_DISMISS_FALLBACK_MS = 350

export function useLaunchAfterSheetCloses<T>(run: (payload: T) => void) {
  const runRef = useRef(run)
  runRef.current = run
  const pendingRef = useRef<T | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const payload = pendingRef.current
    pendingRef.current = null
    if (payload !== null) runRef.current(payload)
  }, [])

  const launchAfterClose = useCallback(
    (payload: T) => {
      pendingRef.current = payload
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, SHEET_DISMISS_FALLBACK_MS)
    },
    [flush],
  )

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )

  return { launchAfterClose, onSheetDismiss: flush }
}
