// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The VM role mix a density soak runs at.
 *
 * Prod shadow data (VmUsageHour over the last 7 days) says a host's resident
 * VMs are overwhelmingly idle: ~16% are mid-agent-turn, ~1% are serving app
 * traffic, and ~83% are resident but doing nothing. That shape is the whole
 * point of the soak — a host's RAM knee is set by the idle tail, not by the
 * turns — so the mix is a first-class input, not a constant.
 *
 * Pure: no I/O, so the allocation is unit-testable.
 */

export type Role = 'agent' | 'app' | 'idle'

export const ROLES: readonly Role[] = ['agent', 'app', 'idle'] as const

export interface Mix {
  agent: number
  app: number
  idle: number
}

/** Prod shadow default: 16% agent / 1% app / 83% idle. */
export const DEFAULT_MIX: Mix = { agent: 0.16, app: 0.01, idle: 0.83 }

/**
 * Parse `agent=0.16,app=0.01,idle=0.83` (or `agent=16,app=1,idle=83`).
 *
 * Percentages and fractions are both accepted: if the parts sum to ~100 they
 * are read as percent, otherwise as fractions. A missing role is 0. The result
 * is normalised to sum to 1 so a hand-typed mix that is off by a rounding
 * error still allocates every VM.
 */
export function parseMix(spec: string): Mix {
  const raw: Record<string, number> = {}
  for (const part of spec.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim())
    if (!k) continue
    if (!ROLES.includes(k as Role)) throw new Error(`unknown role "${k}" in mix (expected ${ROLES.join('/')})`)
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) throw new Error(`bad share "${part}" in mix`)
    raw[k] = n
  }
  const total = ROLES.reduce((s, r) => s + (raw[r] ?? 0), 0)
  if (!(total > 0)) throw new Error(`mix "${spec}" has no positive share`)
  const scale = total > 1.5 ? 100 : 1
  const mix: Mix = { agent: 0, app: 0, idle: 0 }
  for (const r of ROLES) mix[r] = (raw[r] ?? 0) / scale / (total / scale)
  return mix
}

/**
 * Split `n` VMs across the mix by largest remainder, so the counts always sum
 * to exactly `n` and the biggest fractional parts get the leftover VMs.
 * Ties break in ROLES order (agent, app, idle) so the result is deterministic.
 */
export function roleCounts(n: number, mix: Mix): Record<Role, number> {
  if (!Number.isInteger(n) || n < 0) throw new Error(`roleCounts needs a non-negative integer, got ${n}`)
  const exact = ROLES.map((r) => ({ role: r, x: n * mix[r] }))
  const out: Record<Role, number> = { agent: 0, app: 0, idle: 0 }
  let assigned = 0
  for (const e of exact) {
    out[e.role] = Math.floor(e.x)
    assigned += out[e.role]
  }
  const leftover = n - assigned
  const byFraction = [...exact].sort((a, b) => (b.x - Math.floor(b.x)) - (a.x - Math.floor(a.x)) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role))
  for (let i = 0; i < leftover; i++) out[byFraction[i % byFraction.length].role]++
  return out
}

/**
 * The role of each VM index, in a stable interleaved order so a partial ramp
 * (the first k VMs of a step) is already representative of the mix rather than
 * "all the agents first".
 *
 * Even spread: the k-th occurrence of a role with count c is due at
 * (k + 0.5) / c, so every role is spread uniformly across the index range.
 */
export function allocateRoles(n: number, mix: Mix): Role[] {
  const counts = roleCounts(n, mix)
  const due: { at: number; role: Role }[] = []
  for (const r of ROLES) {
    for (let k = 0; k < counts[r]; k++) due.push({ at: (k + 0.5) / counts[r], role: r })
  }
  due.sort((a, b) => a.at - b.at || ROLES.indexOf(a.role) - ROLES.indexOf(b.role))
  return due.map((d) => d.role)
}
