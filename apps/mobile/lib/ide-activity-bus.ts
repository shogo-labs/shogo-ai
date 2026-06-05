// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tiny cross-component bus for asking the IDE Workbench to switch to a specific
 * activity-bar entry (e.g. "checkpoint" to reveal the commit graph).
 *
 * The Workbench owns its `activity` state internally, so surfaces OUTSIDE it —
 * notably the top-bar Publish popover's "View history" link — use this bus to
 * deep-link into the IDE Checkpoint activity. The most recent request is
 * retained as `pending` so it survives the brief window before the Workbench
 * mounts (the Workbench consumes the pending value on mount, then subscribes
 * for subsequent live requests).
 */
type Listener = (activity: string) => void

const listeners = new Set<Listener>()
let pending: string | null = null

/** Request the IDE switch to `activity` (notifies a mounted Workbench, and is
 * retained for one not-yet-mounted Workbench to consume). */
export function requestIdeActivity(activity: string): void {
  pending = activity
  for (const l of listeners) l(activity)
}

/** Read and clear any pending activity request (called by the Workbench on mount). */
export function consumePendingIdeActivity(): string | null {
  const p = pending
  pending = null
  return p
}

/** Subscribe to live activity requests; returns an unsubscribe function. */
export function subscribeIdeActivity(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
