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

export interface TranscriptScrollSignal {
  read(): TranscriptScrollSample
  report(sample: TranscriptScrollSample): void
  subscribe(listener: () => void): () => void
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
  const listeners = new Set<() => void>()

  return {
    read: () => sample,
    report(next) {
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
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
