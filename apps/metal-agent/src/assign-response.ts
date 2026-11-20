// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { OpenResult } from './pool'

/**
 * The JSON body of a successful `POST /assign`, as the control plane reads it
 * (`AssignResult` in apps/api metal-warm-pool-controller.ts).
 *
 * Kept apart from server.ts, which starts listening on import, so the
 * end-to-end tests can serve the exact body production does. Dropping a field
 * here (`repo`, `lateWake`, `phases`) silently blinds the API's wake metrics
 * and the alerts built on them.
 */
export function assignResponseBody(r: OpenResult, url: string) {
  return {
    url,
    mode: r.mode,
    source: r.source,
    readyMs: r.readyMs,
    reused: r.reused,
    // What was ACTUALLY booted, which may be 'standard' even for a docker-class
    // request on a host without that class; the control plane flags mismatches.
    vmClass: r.handle.vmClass,
    phases: r.phases,
    totalMs: r.totalMs,
    staleReason: r.staleReason,
    // Resume only: why the snapshot was taken (`idle` | `evicted`). The control
    // plane labels its wake-latency metric with it, so the cost of the "ready to
    // suspend" bucket is measurable instead of assumed.
    suspendReason: r.suspendReason,
    bootRootfsIdentity: r.bootRootfsIdentity,
    repo: r.repo,
    lateWake: r.lateWake,
  }
}
