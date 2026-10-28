// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A small queue for pushes that wait before they go out. A push is held for
 * a while, and cancelled when the person reads the conversation first.
 *
 * In-memory, like the coalescing map beside it: a restart drops pending pushes,
 * which is acceptable for alerts the person may already have seen.
 */

type Pending = { timer: ReturnType<typeof setTimeout>; run: () => Promise<void> }

const pending = new Map<string, Pending>()

function keyOf(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`
}

/** Runs `run` after `waitMs` unless it is cancelled or already scheduled for this person and conversation. */
export function scheduleDelayedPush(
  userId: string,
  conversationId: string,
  waitMs: number,
  run: () => Promise<void>,
): boolean {
  const key = keyOf(userId, conversationId)
  if (pending.has(key)) return false
  const fire = () => {
    pending.delete(key)
    return run().catch(() => {})
  }
  const timer = setTimeout(() => void fire(), waitMs)
  timer.unref?.()
  pending.set(key, { timer, run: fire })
  return true
}

/** Drops a held push for this person and conversation. Returns how many were cancelled. */
export function cancelDelayedPushes(userId: string, conversationId: string): number {
  const key = keyOf(userId, conversationId)
  const entry = pending.get(key)
  if (!entry) return 0
  clearTimeout(entry.timer)
  pending.delete(key)
  return 1
}

export function delayedPushCount(): number {
  return pending.size
}

/** Test hook: fires every held push now, as if its wait had passed. */
export async function flushDelayedPushesForTests(): Promise<void> {
  const entries = [...pending.values()]
  for (const entry of entries) clearTimeout(entry.timer)
  await Promise.all(entries.map((entry) => entry.run()))
}

export function clearDelayedPushes(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}
