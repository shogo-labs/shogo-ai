// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useDomOverlayOpen — web-only: reports whether any modal / menu overlay is
 * currently visible in the DOM.
 *
 * Why: the desktop external preview is a native Electron `WebContentsView`
 * painted by the OS compositor on top of the renderer, so no CSS z-index can
 * put a React modal above it. Instead of threading an "is a modal open" flag
 * through every call site, the preview watches the DOM for the standard
 * dialog/menu markers (gluestack and React Native Web modals render
 * `role="dialog"` + `aria-modal="true"`) and hides itself while one is open.
 *
 * Custom overlays that render none of these markers can opt in with
 * `dataSet={{ suppressNativePreview: true }}` (renders as
 * `data-suppress-native-preview`).
 *
 * On native (no `document`) this always returns `false`.
 */
import { useEffect, useState } from 'react'

export const OVERLAY_SELECTOR = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[data-suppress-native-preview]',
].join(', ')

const OBSERVED_ATTRIBUTES = [
  'role',
  'aria-modal',
  'style',
  'class',
  'hidden',
  'data-suppress-native-preview',
]

function isRendered(el: Element): boolean {
  if (el.closest('[hidden]')) return false
  const rects = (el as HTMLElement).getClientRects?.()
  // Environments without layout (no getClientRects) fall back to "rendered".
  return rects ? rects.length > 0 : true
}

/**
 * True when `root` contains a rendered overlay element that is not inside
 * `ignoreWithin`. Exported for tests.
 */
export function hasVisibleOverlay(
  root: ParentNode,
  ignoreWithin?: Element | null,
): boolean {
  const matches = root.querySelectorAll(OVERLAY_SELECTOR)
  for (let i = 0; i < matches.length; i++) {
    const el = matches[i]
    if (ignoreWithin && ignoreWithin.contains(el)) continue
    if (isRendered(el)) return true
  }
  return false
}

export function useDomOverlayOpen(
  ignoreRef?: { current: unknown } | null,
): boolean {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return

    let frame = 0
    const schedule = typeof requestAnimationFrame === 'function'
      ? (cb: () => void) => requestAnimationFrame(cb)
      : (cb: () => void) => setTimeout(cb, 16) as unknown as number
    const cancel = typeof cancelAnimationFrame === 'function'
      ? (id: number) => cancelAnimationFrame(id)
      : (id: number) => clearTimeout(id)

    const evaluate = () => {
      frame = 0
      const ignore = ignoreRef?.current
      const next = hasVisibleOverlay(
        document.body,
        ignore instanceof Element ? ignore : null,
      )
      setOpen((prev) => (prev === next ? prev : next))
    }
    const queue = () => {
      if (frame) return
      frame = schedule(evaluate)
    }

    evaluate()
    const observer = new MutationObserver(queue)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    })
    return () => {
      observer.disconnect()
      if (frame) cancel(frame)
    }
  }, [ignoreRef])

  return open
}
