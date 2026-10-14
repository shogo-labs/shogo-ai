// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Two idle-suspend windows for metal runtimes, picked by how full the region is.
 *
 * Suspending an idle VM frees host RAM but makes the next message wait for a
 * resume (or, when the snapshot is gone, a cold boot). That trade is only worth
 * making when the capacity is needed: under the threshold every host keeps
 * idle VMs resident for the RELAXED window, and only once the region is busy
 * does it fall back to the AGGRESSIVE one.
 *
 * Hysteresis: a region at the threshold would otherwise flip on every
 * heartbeat. Once aggressive it stays there until utilization drops
 * `hysteresisPct` points below the threshold. The state lives on the host (it
 * reports the tier it is applying), because heartbeats round-robin across API
 * replicas and none of them sees the full sequence.
 */

export type IdleTier = 'relaxed' | 'aggressive'

export interface IdleDirective {
  idleMs: number
  tier: IdleTier
  fleetUtilPct: number
  computedAt: number
}

export interface IdlePolicyConfig {
  relaxedMs: number
  aggressiveMs: number
  thresholdPct: number
  hysteresisPct: number
}

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

export function idlePolicyConfig(): IdlePolicyConfig {
  return {
    relaxedMs: intEnv('METAL_IDLE_RELAXED_MS', 4 * 60 * 60 * 1000),
    aggressiveMs: intEnv('METAL_IDLE_AGGRESSIVE_MS', 15 * 60 * 1000),
    thresholdPct: intEnv('METAL_IDLE_FLEET_PCT', 60),
    hysteresisPct: intEnv('METAL_IDLE_FLEET_HYSTERESIS_PCT', 5),
  }
}

export function decideIdleTier(utilPct: number, prev: IdleTier | undefined, cfg: IdlePolicyConfig): IdleTier {
  if (utilPct >= cfg.thresholdPct) return 'aggressive'
  if (prev === 'aggressive' && utilPct >= cfg.thresholdPct - cfg.hysteresisPct) return 'aggressive'
  return 'relaxed'
}

export function idleDirective(
  utilPct: number,
  prev: IdleTier | undefined,
  cfg: IdlePolicyConfig,
  now: number,
): IdleDirective {
  const tier = decideIdleTier(utilPct, prev, cfg)
  return {
    idleMs: tier === 'aggressive' ? cfg.aggressiveMs : cfg.relaxedMs,
    tier,
    fleetUtilPct: utilPct,
    computedAt: now,
  }
}
