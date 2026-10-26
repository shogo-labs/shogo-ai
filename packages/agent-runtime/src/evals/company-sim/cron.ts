// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Five-field cron matching in UTC, enough to know when a simulated schedule
 * fires: `*`, `n`, `a-b`, `a,b`, and `/step` on any of them.
 */

const MINUTE = 60_000
const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]

function field(spec: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) return null
    let a: number, b: number
    if (range === '*') { a = lo; b = hi }
    else if (range.includes('-')) { [a, b] = range.split('-').map(Number) }
    else { a = Number(range); b = stepRaw === undefined ? a : hi }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) return null
    for (let n = a; n <= b; n += step) out.add(n)
  }
  return out
}

export interface Cron { matches(at: Date): boolean }

export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const sets = parts.map((p, i) => field(p, RANGES[i]))
  if (sets.some((s) => !s)) return null
  const [min, hour, dom, mon, dow] = sets as Set<number>[]
  const domAny = parts[2] === '*', dowAny = parts[4] === '*'
  return {
    matches(at) {
      if (!min.has(at.getUTCMinutes()) || !hour.has(at.getUTCHours()) || !mon.has(at.getUTCMonth() + 1)) return false
      const d = dom.has(at.getUTCDate()), w = dow.has(at.getUTCDay())
      return domAny && dowAny ? true : domAny ? w : dowAny ? d : d || w
    },
  }
}

/** First minute strictly after `after` the cron fires, or null before `limit`. */
export function nextCronFire(expr: string, after: Date, limit: Date): Date | null {
  const cron = parseCron(expr)
  if (!cron) return null
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE
  for (; t <= limit.getTime(); t += MINUTE) if (cron.matches(new Date(t))) return new Date(t)
  return null
}

/** How many times the cron fires in the 24 hours after `from`. */
export function firesPerDay(expr: string, from = new Date('2026-01-05T00:00:00Z')): number {
  const cron = parseCron(expr)
  if (!cron) return 0
  let n = 0
  for (let t = from.getTime(); t < from.getTime() + 24 * 60 * MINUTE; t += MINUTE) if (cron.matches(new Date(t))) n++
  return n
}
