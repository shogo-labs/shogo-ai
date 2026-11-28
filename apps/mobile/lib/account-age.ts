// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How old an account is, for the two places that have to know (SHO-614).
 *
 * It lives on its own rather than inside `lib/analytics.ts` or
 * `lib/signup-intent.ts` because it is not about capture or storage: `hit_cap`
 * carries it, and onboarding uses it as the only condition under which a
 * carried `?prompt=` may build itself. Both want the same 24-hour rule, and a
 * test that stubs the analytics client should not have to re-stub it.
 */

/** An account this young is still in its first session for funnel purposes. */
export const FIRST_SESSION_MS = 24 * 60 * 60 * 1000

/**
 * True when `createdAt` is within the last 24 hours.
 *
 * `now` is injected so the callers (and their tests) never read the clock
 * implicitly. An unparseable or missing `createdAt` is not a first session,
 * and neither is a timestamp in the future.
 */
export function isFirstSession(
  createdAt: string | number | Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!createdAt) return false
  const created = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime()
  if (!Number.isFinite(created)) return false
  return created <= now && now - created <= FIRST_SESSION_MS
}
