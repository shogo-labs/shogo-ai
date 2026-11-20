// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Workspace compute pricing (SHO-424).
 *
 * A workspace is billed for the microVM time it actually used: for every hour,
 * `vcpus × $/vCPU-hour + GiB × $/GiB-hour`, charged only for the seconds the VM
 * was doing something a user asked for. Idle-tail seconds are metered (so the
 * dashboard can show them) and cost nothing.
 *
 * The numbers are Russell's (2026-11-19, re-cut from SHO-424's $0.10 + $0.005
 * to market shape): $0.07/vCPU-h + $0.012/GiB-h, so the standard 2 vCPU / 4 GiB
 * VM is $0.188 per active hour and $0 idle. RAM is priced high and CPU low
 * because RAM is what limits how many VMs fit on a 512 GB `s3-large-x86` host.
 * There is no separate included-hours allowance — `consumeUsage` draws from the
 * plan's existing included USD, then the wallet, like every other usage type.
 *
 * `computeVmCost` is pure and shared by the hourly job, the workspace estimate
 * and the tests, so the number a customer is shown is the number they are
 * charged, computed the same way.
 */

import type { VmCause } from '../lib/vm-metering/types'

export type IdleBilling = 'full' | 'memory_only' | 'none'

export interface VmPricing {
  /** USD per vCPU-hour of BILLED running time. */
  vcpuHour: number
  /** USD per GiB-hour of BILLED running time. */
  gibHour: number
  /**
   * What idle-tail seconds cost. Russell's decision is `none`: 83% of prod VM
   * hours were the 4-hour idle tail, and charging for it would bill a workspace
   * for leaving a tab open. Kept as a setting so that decision is one word to
   * revisit, not a refactor.
   */
  idleBilling: IdleBilling
  /**
   * Causes that are never billed, whatever the meters say:
   *  - `rewarm`   — the platform re-warming an always-on runtime after a rollout.
   *  - `prewarm`  — the switch-over pre-warm that boots the staged rootfs.
   *  - `published`— a live published site's VM, already billed as
   *                 `published_hosting` (charging again would double-charge).
   */
  neverBilledCauses: VmCause[]
}

export const VM_PRICING: VmPricing = {
  vcpuHour: 0.07,
  gibHour: 0.012,
  idleBilling: 'none',
  neverBilledCauses: ['rewarm', 'prewarm', 'published'],
}

export interface VmUsageInput {
  vcpus: number
  memMiB: number
  /** Seconds of an in-flight agent turn (billable). */
  agentSeconds: number
  /** Seconds serving end-user app traffic (billable). */
  appSeconds: number
  /** Seconds of the idle-suspend tail (billable only if `idleBilling` says so). */
  idleSeconds: number
  cause: VmCause | string
}

export interface VmUsageCost {
  /** Seconds actually charged for. */
  billedSeconds: number
  vcpuHours: number
  gibHours: number
  /** USD from the vCPU component. */
  vcpuUsd: number
  /** USD from the memory component. */
  memoryUsd: number
  totalUsd: number
  /** Metred seconds the pricing deliberately did not charge for. */
  freeSeconds: number
  /** True when the cause is on the never-billed list. */
  freeCause: boolean
}

const SECONDS_PER_HOUR = 3600
const MIB_PER_GIB = 1024

/** Is this cause ever billable, whatever the meters say? */
export function isBillableCause(cause: VmCause | string, pricing: VmPricing = VM_PRICING): boolean {
  return !pricing.neverBilledCauses.includes(cause as VmCause)
}

/** The seconds of THIS row that the pricing charges for. */
export function billedSeconds(input: VmUsageInput, pricing: VmPricing = VM_PRICING): number {
  if (!isBillableCause(input.cause, pricing)) return 0
  const active = Math.max(0, input.agentSeconds) + Math.max(0, input.appSeconds)
  const idle = Math.max(0, input.idleSeconds)
  if (pricing.idleBilling === 'full') return active + idle
  // `memory_only` charges the idle tail's memory (the resident cost of a
  // suspended-but-resident VM) and nothing for its vCPU. Expressed in seconds
  // here so callers still get one number; `computeVmCost` splits the price.
  return active + (pricing.idleBilling === 'memory_only' ? idle : 0)
}

/**
 * Cost of one metering row. Pure — the hourly bill job, the workspace estimate
 * and the tests all call this, so they cannot disagree.
 */
export function computeVmCost(input: VmUsageInput, pricing: VmPricing = VM_PRICING): VmUsageCost {
  const freeCause = !isBillableCause(input.cause, pricing)
  const active = Math.max(0, input.agentSeconds) + Math.max(0, input.appSeconds)
  const idle = Math.max(0, input.idleSeconds)
  const totalSeconds = active + idle

  if (freeCause || totalSeconds <= 0) {
    return {
      billedSeconds: 0,
      vcpuHours: 0,
      gibHours: 0,
      vcpuUsd: 0,
      memoryUsd: 0,
      totalUsd: 0,
      freeSeconds: totalSeconds,
      freeCause,
    }
  }

  // Idle seconds contribute vCPU time only when idle is billed in full; the
  // memory component of an idle VM is always resident (that is the whole point
  // of the `memory_only` mode).
  const idleVcpuSeconds = pricing.idleBilling === 'full' ? idle : 0
  const idleMemSeconds = pricing.idleBilling === 'none' ? 0 : idle
  const billedVcpuSeconds = active + idleVcpuSeconds
  const billedMemSeconds = active + idleMemSeconds

  const vcpus = Math.max(0, input.vcpus)
  const gib = Math.max(0, input.memMiB) / MIB_PER_GIB

  const vcpuHours = (billedVcpuSeconds * vcpus) / SECONDS_PER_HOUR
  const gibHours = (billedMemSeconds * gib) / SECONDS_PER_HOUR
  const vcpuUsd = vcpuHours * pricing.vcpuHour
  const memoryUsd = gibHours * pricing.gibHour

  return {
    billedSeconds: billedSeconds(input, pricing),
    vcpuHours,
    gibHours,
    vcpuUsd,
    memoryUsd,
    totalUsd: vcpuUsd + memoryUsd,
    freeSeconds: totalSeconds - billedSeconds(input, pricing),
    freeCause,
  }
}

/** Round to 6dp — the precision `consumeUsage` records. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** `VM_BILLING_MODE=shadow|enforce`, default `shadow`. */
export function vmBillingMode(env: NodeJS.ProcessEnv = process.env): 'shadow' | 'enforce' {
  return env.VM_BILLING_MODE === 'enforce' ? 'enforce' : 'shadow'
}
