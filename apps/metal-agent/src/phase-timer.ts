// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-open wall-clock breakdown. `open()` threads one of these through
 * resume/assign so the /assign response can say where a slow wake spent its
 * time (queue wait vs S3 vs restore vs guest hooks) instead of one opaque
 * number. Repeated phases accumulate.
 */
export class PhaseTimer {
  private readonly startedAt = performance.now()
  private readonly ms: Record<string, number> = {}

  add(phase: string, ms: number): void {
    this.ms[phase] = (this.ms[phase] ?? 0) + ms
  }

  async time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now()
    try {
      return await fn()
    } finally {
      this.add(phase, performance.now() - t0)
    }
  }

  totalMs(): number {
    return Math.round(performance.now() - this.startedAt)
  }

  phases(): Record<string, number> {
    return Object.fromEntries(Object.entries(this.ms).map(([k, v]) => [k, Math.round(v)]))
  }
}

/** Why a snapshot was not used for a resume. Bounded set: it is a metric label. */
export type StaleReason =
  | 'rootfs'
  | 'source'
  | 'repo'
  | 'data'
  | 'home'
  | 'member_data'
  | 'member_source'
  | 'foreign_members'
  | 'resume_error'
  | 'no_snapshot'
