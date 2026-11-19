// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { readFileSync } from 'fs'

/**
 * MemTotal / MemAvailable from /proc/meminfo, in MiB. Undefined off Linux.
 *
 * Lives in its own module (rather than register.ts) because both the heartbeat
 * and the eviction policy read it, and pool.ts must not import register.ts —
 * register.ts imports pool.ts.
 */
export function hostMemory(meminfo?: string): { totalMiB: number; availableMiB: number } | undefined {
  let text = meminfo
  if (text === undefined) {
    try {
      text = readFileSync('/proc/meminfo', 'utf8')
    } catch {
      return undefined
    }
  }
  const kb = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(text!)?.[1])
  const total = kb('MemTotal')
  const available = kb('MemAvailable')
  if (!(total > 0) || !(available >= 0)) return undefined
  return { totalMiB: Math.round(total / 1024), availableMiB: Math.round(available / 1024) }
}
