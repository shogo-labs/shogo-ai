// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Which idle-suspend window this host applies on a reaper pass.
 *
 * The control plane hands back a directive on every heartbeat (see
 * apps/api/src/lib/metal-idle-policy.ts): a RELAXED window while the region
 * has headroom, an AGGRESSIVE one once it is busy. The host only ever narrows
 * that, never widens it:
 *   - no directive, or one older than a few heartbeats → `METAL_IDLE_SUSPEND_MS`
 *     (the aggressive window). A host cut off from the API cannot know the
 *     region is quiet, and keeping everything resident is how it runs out.
 *   - this host itself near its VM cap → aggressive, whatever the region says.
 */

import { config } from './config'

export type IdleTier = 'relaxed' | 'aggressive'
export type IdleReason = 'directive' | 'stale' | 'host_guard' | 'static'

export interface IdleDirective {
  idleMs: number
  tier: IdleTier
  fleetUtilPct?: number
  computedAt?: number
}

export interface IdleWindow {
  idleMs: number
  tier: IdleTier
  reason: IdleReason
  /** Tier of the last directive received, which the control plane's hysteresis keys off. */
  directiveTier?: IdleTier
}

export interface IdleWindowInput {
  directive?: IdleDirective & { receivedAt: number }
  now: number
  staleAfterMs: number
  /** `METAL_IDLE_SUSPEND_MS`; also the aggressive fallback. */
  aggressiveMs: number
  assigned: number
  maxVms: number
  hostGuardPct: number
  /** No control plane configured: the static window is all there is. */
  standalone: boolean
}

export function resolveIdleWindow(i: IdleWindowInput): IdleWindow {
  const d = i.directive
  const directiveTier = d?.tier
  if (i.standalone) return { idleMs: i.aggressiveMs, tier: 'aggressive', reason: 'static' }
  if (!d || !(d.idleMs > 0) || i.now - d.receivedAt > i.staleAfterMs) {
    return { idleMs: i.aggressiveMs, tier: 'aggressive', reason: 'stale', directiveTier }
  }
  if (i.maxVms > 0 && (i.assigned / i.maxVms) * 100 >= i.hostGuardPct) {
    return { idleMs: Math.min(d.idleMs, i.aggressiveMs), tier: 'aggressive', reason: 'host_guard', directiveTier }
  }
  return { idleMs: d.idleMs, tier: d.tier, reason: 'directive', directiveTier }
}

let last: (IdleDirective & { receivedAt: number }) | undefined

export function setIdleDirective(d: unknown, now = Date.now()): void {
  if (!d || typeof d !== 'object') return
  const r = d as Record<string, unknown>
  const idleMs = Number(r.idleMs)
  const tier = r.tier === 'relaxed' || r.tier === 'aggressive' ? r.tier : undefined
  if (!tier || !Number.isFinite(idleMs)) return
  last = {
    idleMs,
    tier,
    fleetUtilPct: typeof r.fleetUtilPct === 'number' ? r.fleetUtilPct : undefined,
    computedAt: typeof r.computedAt === 'number' ? r.computedAt : undefined,
    receivedAt: now,
  }
}

/** Test-only. */
export function _resetIdleDirective(): void {
  last = undefined
}

export function currentIdleWindow(assigned: number, now = Date.now()): IdleWindow {
  return resolveIdleWindow({
    directive: last,
    now,
    staleAfterMs: 3 * config.registerIntervalMs + 15_000,
    aggressiveMs: config.idleSuspendMs,
    assigned,
    maxVms: config.maxVmsPerHost,
    hostGuardPct: config.idleHostGuardPct,
    standalone: !config.controlPlaneUrl,
  })
}
