// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The two lifecycle nudges the API pushes (SHO-258 §4): a build that finished
 * while the person was away, and a usage limit that came back. Both carry
 * `data.type` on the push and both open a project chat — the one the server
 * named, or the project's most recently active chat (SHO-266).
 *
 * Kept in its own module so both the native and web notifiers (and the click
 * router) can read it without importing each other.
 */

export type LifecycleNotificationKind = 'build-ready' | 'credits-reset'

export const LIFECYCLE_NOTIFICATION_KINDS: readonly LifecycleNotificationKind[] = [
  'build-ready',
  'credits-reset',
]

/** The lifecycle kind a push's `data.type` names, or `null` for anything else. */
export function lifecycleNotificationKind(raw: unknown): LifecycleNotificationKind | null {
  return typeof raw === 'string' &&
    (LIFECYCLE_NOTIFICATION_KINDS as readonly string[]).includes(raw)
    ? (raw as LifecycleNotificationKind)
    : null
}
