// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Notification Service — in-app notification inbox writes.
 *
 * Single choke point for creating `notifications` rows (the in-app inbox the
 * mobile bell/badge reads via the generated `/api/notifications` CRUD). All
 * writes are best-effort: a failed insert logs and resolves rather than
 * throwing, so a notification can never break the billing/usage path that
 * triggered it.
 *
 * Billing callers should prefer `notifyWorkspaceBillingAdmins`, which fans a
 * single payload out to the workspace owner plus any billing admins and
 * dedupes per `dedupeKey` (e.g. a Stripe invoice id) so webhook retries don't
 * create duplicate inbox rows.
 */

import { prisma } from '../lib/prisma'
// Type-only: in SQLite/local mode the generated client stores enums as plain
// strings and exposes no runtime `NotificationType` value, so importing it as a
// value would break module loading (and any test that mocks `../lib/prisma`).
// Callers pass the string-literal members, which are assignable to this union.
import type { NotificationType } from '../lib/prisma'

/** Writable notification payload. `type` accepts the `NotificationType` enum. */
export interface CreateNotificationInput {
  userId: string
  type: NotificationType
  title: string
  message: string
  /**
   * Arbitrary JSON context (rendered/used by the client). When `dedupeKey` is
   * set it is merged in under `dedupeKey` so the same logical event is not
   * inserted twice.
   */
  metadata?: Record<string, unknown>
  /** Optional client deep link, e.g. `shogo://billing?workspace=...`. */
  actionUrl?: string
  /**
   * When set, skip the insert if a notification with the same `(userId, type,
   * dedupeKey)` already exists. Used to make webhook-driven notifications
   * idempotent across Stripe retries.
   */
  dedupeKey?: string
}

/** How many recent rows to scan when honoring `dedupeKey`. */
const DEDUPE_SCAN_LIMIT = 100

/**
 * Create a single in-app notification. Best-effort: returns the created row,
 * `null` when skipped as a duplicate, or `null` on error (logged).
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<{ id: string } | null> {
  try {
    if (input.dedupeKey) {
      const recent = await prisma.notification.findMany({
        where: { userId: input.userId, type: input.type },
        orderBy: { createdAt: 'desc' },
        take: DEDUPE_SCAN_LIMIT,
        select: { id: true, metadata: true },
      })
      const already = recent.some(
        (n) => (n.metadata as { dedupeKey?: string } | null)?.dedupeKey === input.dedupeKey,
      )
      if (already) return null
    }

    const metadata = input.dedupeKey
      ? { ...(input.metadata ?? {}), dedupeKey: input.dedupeKey }
      : input.metadata

    const row = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        ...(metadata !== undefined ? { metadata: metadata as object } : {}),
        ...(input.actionUrl ? { actionUrl: input.actionUrl } : {}),
      },
      select: { id: true },
    })
    return row
  } catch (err) {
    console.error('[notifications] createNotification failed:', (err as Error)?.message ?? err)
    return null
  }
}

/** Payload for a workspace-scoped notification (recipients resolved internally). */
export type WorkspaceNotificationInput = Omit<CreateNotificationInput, 'userId'>

/**
 * Resolve the users who should receive billing/usage notifications for a
 * workspace: the owner(s) plus anyone explicitly flagged `isBillingAdmin`.
 * De-duplicated so a user who is both owner and billing admin is notified once.
 */
export async function getWorkspaceBillingRecipients(workspaceId: string): Promise<string[]> {
  try {
    const members = await prisma.member.findMany({
      where: {
        workspaceId,
        OR: [{ role: 'owner' }, { isBillingAdmin: true }],
      },
      select: { userId: true },
    })
    return Array.from(new Set(members.map((m) => m.userId)))
  } catch (err) {
    console.error('[notifications] getWorkspaceBillingRecipients failed:', (err as Error)?.message ?? err)
    return []
  }
}

/**
 * Fan a notification out to every billing recipient of a workspace. Honors
 * `dedupeKey` per recipient. Returns the number of rows created.
 */
export async function notifyWorkspaceBillingAdmins(
  workspaceId: string,
  payload: WorkspaceNotificationInput,
): Promise<number> {
  const recipients = await getWorkspaceBillingRecipients(workspaceId)
  let created = 0
  for (const userId of recipients) {
    const row = await createNotification({ ...payload, userId })
    if (row) created += 1
  }
  return created
}

/** Count a user's unread (readAt IS NULL) notifications. */
export async function getUnreadNotificationCount(userId: string): Promise<number> {
  try {
    return await prisma.notification.count({ where: { userId, readAt: null } })
  } catch (err) {
    console.error('[notifications] getUnreadNotificationCount failed:', (err as Error)?.message ?? err)
    return 0
  }
}
