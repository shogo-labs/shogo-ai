// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Helpers for the emailed invitation link (`/invitations/<id>/accept`).
 *
 * Kept out of the route file so the id/next handling can be unit-tested
 * without pulling Expo Router and the RN renderer into the test process.
 */

/** A route param as one string — Expo hands back `string | string[]`. */
export function paramToString(raw: string | string[] | undefined | null): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * The invitation id, or null when the link carried nothing usable (an
 * `/invitations//accept` link, a truncated mail). Callers render "no longer
 * exists" rather than fetching `/api/invitations//info`.
 */
export function normalizeInvitationId(raw: string | string[] | undefined | null): string | null {
  return paramToString(raw) ?? null
}

/**
 * Absolute path of the accept page. Used as the `next` param for sign-in, which
 * requires a same-origin path starting with a single `/`.
 */
export function invitationAcceptPath(id: string): string {
  return `/invitations/${encodeURIComponent(id)}/accept`
}

/**
 * What the accept page can do with an invitation, from the public info payload.
 *
 * - `pending`    → show Accept
 * - `accepted`   → "already used", no button
 * - `expired`    → past `expiresAt` (or `status: expired`), no button
 * - `unavailable`→ declined/cancelled by an admin, no button
 */
export type InvitationPhase = 'pending' | 'accepted' | 'expired' | 'unavailable'

export function invitationPhase(info: { status: string; expired: boolean }): InvitationPhase {
  switch (info.status) {
    case 'accepted':
      return 'accepted'
    case 'pending':
      return info.expired ? 'expired' : 'pending'
    case 'expired':
      return 'expired'
    default:
      return 'unavailable'
  }
}
