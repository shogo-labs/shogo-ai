// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The in-app link behind a lifecycle notification row (SHO-266).
 *
 * The API writes two kinds of nudge (`apps/api/src/lib/lifecycle-notifications.ts`,
 * SHO-258 §4). Their `actionUrl` is an absolute `${appBaseUrl()}/chat?project=…`,
 * which is a *web* address — there is no `/chat` route in `apps/mobile`, and the
 * inbox only follows actionUrls that start with `/`. What the app can route is
 * the row's own data: `type` names the kind and `metadata.projectId` names the
 * project, so the inbox maps those to the flagged project route instead of
 * pushing `actionUrl` verbatim.
 *
 * Kept out of the screen so the mapping is unit-testable and shared with the
 * push click router.
 */
import { type LifecycleNotificationKind } from './lifecycle-click'

/** `Notification.type` → the lifecycle kind that row announces. */
const LIFECYCLE_ROW_TYPES: Readonly<Record<string, LifecycleNotificationKind>> = {
  build_ready: 'build-ready',
  credits_reset: 'credits-reset',
}

/** Where a tapped lifecycle row takes the person. */
export type LifecycleNotificationRoute =
  | { pathname: '/(app)/projects/[id]'; params: { id: string; fromLifecycle: LifecycleNotificationKind } }
  | { pathname: '/(app)/projects'; params: Record<string, never> }

/** The lifecycle kind a notification row announces, or `null` for other rows. */
export function lifecycleKindForNotificationType(
  type: unknown,
): LifecycleNotificationKind | null {
  if (typeof type !== 'string') return null
  return LIFECYCLE_ROW_TYPES[type] ?? null
}

/**
 * A notification's `metadata`, which is a JSON string on the wire (the domain
 * store freezes it into an object, and pre-existing rows may carry anything).
 */
export function notificationMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata)
      return isPlainObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return isPlainObject(metadata) ? metadata : {}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The route a tapped notification row opens, or `null` when the row is not a
 * lifecycle nudge.
 *
 * A `credits_reset` row carries no project (`metadata` is `{workspaceId,
 * resetAt}`: the wallet that ran out need not have built anything), so it lands
 * on the project list and the person picks — better than an actionUrl that goes
 * nowhere.
 */
export function lifecycleNotificationRoute(row: {
  type?: unknown
  metadata?: unknown
}): LifecycleNotificationRoute | null {
  const kind = lifecycleKindForNotificationType(row.type)
  if (!kind) return null
  const projectId = notificationMetadata(row.metadata).projectId
  if (typeof projectId === 'string' && projectId.trim() !== '') {
    return {
      pathname: '/(app)/projects/[id]',
      params: { id: projectId.trim(), fromLifecycle: kind },
    }
  }
  return { pathname: '/(app)/projects', params: {} }
}
