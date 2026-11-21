// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Wire types for metal VM compute metering (SHO-424).
 *
 * The producer is the node-agent (`apps/metal-agent/src/pool.ts` — its
 * `meterReport()`), which is a separate deployable and cannot import this
 * module, so the shape is duplicated there. It is a wire contract: change both
 * sides together, and keep it additive (an older agent that omits a field must
 * still be ingestible — see `ingestMetalMeters`).
 */

export type VmCause = 'user_open' | 'agent_wake' | 'schedule' | 'published' | 'rewarm' | 'prewarm'

export const VM_CAUSES: readonly VmCause[] = [
  'user_open',
  'agent_wake',
  'schedule',
  'published',
  'rewarm',
  'prewarm',
]

export function isVmCause(v: unknown): v is VmCause {
  return typeof v === 'string' && (VM_CAUSES as readonly string[]).includes(v)
}

/** One VM's cumulative counters, as the agent reports them. */
export interface VmMeterReport {
  /** The agent's runtime key: `<projectId>`, `ws:<workspaceId>`, `ws:proj:<projectId>` or `published:<id>`. */
  runtimeKey: string
  vmId: string
  /** Epoch ms of the assignment — with hostId + vmId, the identity of this meter series. */
  assignedAt: number
  vcpus: number
  memMiB: number
  vmClass: string
  cause: VmCause
  alwaysOn: boolean
  agentMs: number
  appMs: number
  idleMs: number
  /** Set once the VM stopped being assigned. Informational; the counters are what is ingested. */
  endedAt?: number
}

/** The `meter` block of a register heartbeat. */
export interface MetalMeterPayload {
  seq: number
  vms: VmMeterReport[]
  closed?: VmMeterReport[]
}

export interface IngestMetersResult {
  /** Highest seq seen (what the agent is told it may forget). */
  ack: number
  /** VM rows considered (live + closed). */
  rows: number
  /** Rows that produced billable/measured time. */
  metered: number
  /** VM rows skipped because their workspace or project no longer exists. */
  unresolved: number
  /** Seconds of running time written into `VmUsageHour` rows. */
  agentSeconds: number
  appSeconds: number
  idleSeconds: number
  /** Rows the agent sent with an unusable shape (an error, not a retry). */
  invalid: number
  /** Rows that threw an unexpected error during metering (triggers no-ack). */
  failed: number
}
