// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which card a chat session is working on (SHO-509).
 *
 * A declared service (`exec({ service: true })`) used to have no owner beyond
 * its session, so a service started while a developer was on SHO-490 was still
 * restarted days later, after the card was Done and the session long gone —
 * four projects' worth of them is what exhausted the machine's process table.
 * A declaration now records the card it belongs to, and the card's column is
 * what decides whether the service comes back (see
 * `AgentGateway.restartDeclaredServices`).
 *
 * The claim is noted at the one choke point every board tool goes through
 * (`defineTool` in board-tools.ts): a session that calls `work_item_get`,
 * `work_item_move`, `work_item_update`, … on a card is working on that card.
 * Kept in memory: it is a hint for the next declaration, and a runtime restart
 * re-learns it on the session's first board call.
 */

interface Claim {
  key: string
  at: number
}

const claims = new Map<string, Claim>()

/** A session touched `key` — it is working on that card. */
export function noteWorkItemClaim(sessionId: string | undefined, key: string | null | undefined): void {
  if (!sessionId || !key) return
  const trimmed = String(key).trim()
  // A card key is `ABC-123`; anything else (a user id, a board name) is not a
  // claim and must not become one.
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(trimmed)) return
  claims.set(sessionId, { key: trimmed.toUpperCase(), at: Date.now() })
}

/** The card this session is working on, if it has touched one. */
export function claimedWorkItemKey(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  return claims.get(sessionId)?.key
}

export function forgetWorkItemClaim(sessionId: string): void {
  claims.delete(sessionId)
}

/** Test seam. */
export function resetWorkItemClaimsForTests(): void {
  claims.clear()
}
