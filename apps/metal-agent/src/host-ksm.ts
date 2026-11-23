// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { readFileSync, readdirSync } from 'fs'

/**
 * Host KSM (same-page merging) counters, read from /sys/kernel/mm/ksm and
 * ksmd's own CPU time (SHO-534).
 *
 * The agent does not switch KSM on — host-bootstrap.sh does, behind `METAL_KSM`,
 * with the systemd unit's `MemoryKSM=` making the firecracker processes'
 * memory mergeable in the first place. What the agent does is REPORT it: how
 * much is actually being shared, how hard ksmd is working, and how long a full
 * pass takes, because the whole question of keeping KSM on is decided from the
 * measured gain against that CPU cost.
 *
 * Everything here is a pure parse plus one optional /proc walk so it can be
 * tested off a real host; `undefined` means the host has no KSM (the kernel was
 * built without it, or the sysfs tree is absent), not "KSM is off".
 */

export interface KsmCounters {
  /** /sys/kernel/mm/ksm/run — 1 = ksmd is scanning, 2 = merge-and-stop. */
  run: boolean
  /** Pages that are currently shared (savings). */
  pagesSharing: number
  /** Pages merged at least once over the host's lifetime. */
  pagesShared: number
  /** Full scans completed — flat while VMs churn means ksmd is behind. */
  fullScans: number
}

export interface KsmdCpuSample {
  /** Cumulative CPU ticks (utime + stime) of the ksmd kernel thread. */
  ticks: number
  /** Wall clock of the sample, ms. */
  at: number
}

/**
 * Parse the four sysfs files. `read` returns undefined for a missing file so a
 * host with KSM compiled in but never started still reports zeros.
 */
export function parseKsmCounters(read: (file: string) => string | undefined): KsmCounters | undefined {
  const run = read('run')
  if (run === undefined) return undefined
  const num = (file: string) => {
    const v = Number(read(file))
    return Number.isFinite(v) && v >= 0 ? v : 0
  }
  return {
    run: Number(run.trim()) !== 0,
    pagesSharing: num('pages_sharing'),
    pagesShared: num('pages_shared'),
    fullScans: num('full_scans'),
  }
}

/**
 * ksmd's CPU as a percentage of one core between two samples. USER_HZ is 100 on
 * every x86_64/aarch64 Linux we run, so ticks/100 is seconds of CPU. The first
 * sample after a restart has no predecessor, hence `undefined` rather than a
 * misleading 0 — and a clock that steps backwards yields 0, not a spike.
 */
export function ksmdCpuPct(
  prev: KsmdCpuSample | undefined,
  cur: KsmdCpuSample,
): number | undefined {
  if (!prev) return undefined
  const elapsedMs = cur.at - prev.at
  if (elapsedMs <= 0) return undefined
  const ticks = cur.ticks - prev.ticks
  if (ticks < 0) return 0
  return +(((ticks / 100) * 1000 * 100) / elapsedMs).toFixed(2)
}

/**
 * Find ksmd's pid. KSM is a kernel thread named `ksmd`, so it is the only
 * process whose `comm` matches; there is one per host. Returns undefined when
 * the thread is not running (KSM never started), which is the normal state of
 * every prod host today.
 */
export function findKsmdPid(readdir: (dir: string) => string[], read: (file: string) => string | undefined): number | undefined {
  for (const entry of readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    if (read(`/proc/${entry}/comm`)?.trim() === 'ksmd') return Number(entry)
  }
  return undefined
}

/** utime + stime (fields 14 and 15 of /proc/<pid>/stat) for a pid. */
export function procCpuTicks(stat: string | undefined): number | undefined {
  if (!stat) return undefined
  // The comm field is parenthesised and may contain spaces, so split after it.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined
  return utime + stime
}

let lastKsmd: KsmdCpuSample | undefined

/**
 * Sample everything KSM on this host, keeping the previous ksmd CPU sample
 * between calls so the percentage is a real delta. Called from the pool's gauge
 * pass (per reaper tick / heartbeat), which is frequent enough for a
 * meaningful rate on a counter that moves over seconds to minutes.
 */
export function hostKsm(now = Date.now()): (KsmCounters & { ksmdCpuPct?: number }) | undefined {
  const base = '/sys/kernel/mm/ksm/'
  const read = (file: string) => {
    try {
      return readFileSync(base + file, 'utf8')
    } catch {
      return undefined
    }
  }
  const counters = parseKsmCounters(read)
  if (!counters) return undefined

  const pid = findKsmdPid(
    (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
    (file) => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    },
  )
  if (pid === undefined) return counters
  const ticks = procCpuTicks(
    (() => {
      try {
        return readFileSync(`/proc/${pid}/stat`, 'utf8')
      } catch {
        return undefined
      }
    })(),
  )
  if (ticks === undefined) return counters
  const prev = lastKsmd
  lastKsmd = { ticks, at: now }
  const pct = ksmdCpuPct(prev, lastKsmd)
  return pct === undefined ? counters : { ...counters, ksmdCpuPct: pct }
}
