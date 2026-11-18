// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * What the transcript should do when its content height changes.
 *
 * Kept out of `ChatPanel` so the rule can be tested directly: the panel is
 * where a resumed chat used to be pulled down several times, because the first
 * layout of a whole turn window was treated as ordinary growth and animated
 * through every intermediate height (SHO-407).
 */

/**
 * Smallest height change that counts as real growth. Above sub-pixel jitter
 * (≤3 px) but well below a line of text (~16-20 px), so token streaming still
 * follows while a spring animation inside a widget does not.
 */
export const AUTOSCROLL_MIN_DELTA_PX = 4

export type ContentSizeAction =
  /** First layout of this session: land at the true bottom, once, unanimated. */
  | { kind: "settle-initial-layout"; scrollToEnd: boolean }
  /** A "load earlier" page landed above the reader: keep their place. */
  | { kind: "anchor-load-older"; delta: number }
  /** Real growth while following: queue the throttled scroll to the end. */
  | { kind: "follow-growth" }
  | { kind: "none" }

export interface ContentSizeChangeInput {
  /** False until the transcript's first layout for this session has finished. */
  initialLayoutSettled: boolean
  /** A "load earlier" page is settling; its own anchor math owns the offset. */
  isLoadingOlder: boolean
  isNative: boolean
  /** Native only: the reader is pinned to the bottom. */
  stickToBottom: boolean
  /** Content height before this change; 0 means nothing has been laid out yet. */
  previousHeight: number
  nextHeight: number
  minDelta?: number
}

export function decideContentSizeChange({
  initialLayoutSettled,
  isLoadingOlder,
  isNative,
  stickToBottom,
  previousHeight,
  nextHeight,
  minDelta = AUTOSCROLL_MIN_DELTA_PX,
}: ContentSizeChangeInput): ContentSizeAction {
  if (!initialLayoutSettled) {
    return { kind: "settle-initial-layout", scrollToEnd: true }
  }

  const delta = nextHeight - previousHeight

  if (isLoadingOlder) {
    return delta > 0 && previousHeight > 0
      ? { kind: "anchor-load-older", delta }
      : { kind: "none" }
  }

  if (isNative && stickToBottom && previousHeight > 0 && delta >= minDelta) {
    return { kind: "follow-growth" }
  }

  return { kind: "none" }
}
