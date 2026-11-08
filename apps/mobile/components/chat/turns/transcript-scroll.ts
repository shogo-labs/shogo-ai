// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Transcript scroll signal (SHO-354).
 *
 * The windowed turn list has to know where the transcript is scrolled to
 * decide when to mount turns again, but routing that through ChatPanel state
 * would re-render the whole panel on every scroll frame — the opposite of
 * what this work is for.
 *
 * So the ScrollView reports its offset into a tiny external store. `TurnList`
 * subscribes to it and re-renders only when the window itself has to change,
 * never once per scroll event.
 */

export interface TranscriptScrollSample {
  /** Scroll offset in px from the top of the content. */
  y: number
  /** Visible height of the scroll view. */
  viewportHeight: number
  /** Total content height. */
  contentHeight: number
}

/**
 * Where a reported offset came from.
 *
 * `correction` is the panel's own reading-position repair (a window expansion
 * made the content above the reader taller or shorter). It is still the true
 * offset — subscribers that read the signal later must see it — but the turn
 * window must not treat it as the person moving, or a correction that lands
 * near the top triggers the next expansion and the hook feeds itself
 * (SHO-359).
 */
export type TranscriptScrollOrigin = "scroll" | "correction"

export interface TranscriptScrollSignal {
  read(): TranscriptScrollSample
  report(sample: TranscriptScrollSample, origin?: TranscriptScrollOrigin): void
  subscribe(listener: (origin: TranscriptScrollOrigin) => void): () => void
}

const ORIGIN: TranscriptScrollSample = {
  y: 0,
  viewportHeight: 0,
  contentHeight: 0,
}

export function createTranscriptScrollSignal(
  initial: TranscriptScrollSample = ORIGIN,
): TranscriptScrollSignal {
  let sample = initial
  const listeners = new Set<(origin: TranscriptScrollOrigin) => void>()

  return {
    read: () => sample,
    report(next, origin = "scroll") {
      // Ignore identical reports: a ScrollView fires on every frame and the
      // subscribers only care about meaningful movement.
      if (
        next.y === sample.y &&
        next.viewportHeight === sample.viewportHeight &&
        next.contentHeight === sample.contentHeight
      ) {
        return
      }
      sample = next
      for (const listener of listeners) listener(origin)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Web only: stop the browser from running its own scroll anchoring on the
 * transcript.
 *
 * Chromium/Electron anchors the visible content by default (`overflow-anchor:
 * auto`), so it already moves `scrollTop` when a turn mounts above the reader
 * or an estimate is replaced by the real height. The turn window corrects for
 * the same change (`real − estimate`, the only correction that also works on
 * native), so with anchoring left on every expansion is applied twice and the
 * transcript is thrown by `dy` — down when the real turns are taller than the
 * estimate, up when they are shorter (SHO-359).
 *
 * One owner of the reading position: the hook, on every platform.
 */
export function optOutOfBrowserScrollAnchoring(node: unknown): void {
  const style = (node as { style?: { overflowAnchor?: string } } | null)?.style
  if (!style) return
  style.overflowAnchor = "none"
}
