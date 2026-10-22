// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project calls / card hand-offs that are in flight to a runtime but have not
 * made a turn appear there yet.
 *
 * These are the requests whose whole job is to start work in another
 * runtime. For the few milliseconds between "the API sent it" and "the
 * runtime's turn lock exists" the target looks idle to a probe, and the
 * background pool can be evicting it at that exact moment (SHO-143). Counting
 * them here makes them visible to the eviction decision.
 *
 * A plain module-level counter (not a service) so the call site does not need
 * the RuntimeManager: it just brackets the forward with +1/-1.
 */
const inflight = new Map<string, number>()

/** Count a project call as in flight (+1) or finished (-1). */
export function noteInflightCall(projectId: string, delta: 1 | -1): void {
  if (!projectId) return
  const next = Math.max(0, (inflight.get(projectId) ?? 0) + delta)
  if (next === 0) inflight.delete(projectId)
  else inflight.set(projectId, next)
}

/** Project calls currently in flight to this project. */
export function inflightCallCount(projectId: string): number {
  return inflight.get(projectId) ?? 0
}

/** Test seam: drop all counts. */
export function resetInflightCalls(): void {
  inflight.clear()
}
