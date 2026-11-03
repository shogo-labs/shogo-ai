// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one conflict rule of a hosted workspace's two-way sync (SHO-285), shared
 * by the cloud's ingest and the desktop's puller so both sides agree.
 */

function timeOf(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' || typeof value === 'number') {
    const t = new Date(value).getTime()
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * Last writer wins, per row, by `updatedAt` (SHO-285). A row without an
 * `updatedAt` column is append-only (messages, tool logs, events) and is simply
 * written; writing the same row twice changes nothing.
 */
export function incomingWins(existing: Record<string, unknown> | undefined, incoming: Record<string, unknown>): boolean {
  if (!existing) return true
  const before = timeOf(existing.updatedAt)
  const after = timeOf(incoming.updatedAt)
  if (before === null || after === null) return true
  return after >= before
}

