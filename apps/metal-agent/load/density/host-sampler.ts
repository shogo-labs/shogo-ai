// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host-side sampler for the density soak.
 *
 * Everything here is measured from the HOST, not the guest, because the host is
 * where the contention is. In-guest `/proc/stat` steal is only a secondary
 * column (KVM steal-time is not always exposed), so the primary CPU signal is
 * per-Firecracker-vCPU-thread `run_delay` from `/proc/<pid>/task/<tid>/schedstat`
 * — the time a runnable vCPU thread waited for a physical CPU. That is the
 * number that says "this host is oversubscribed".
 *
 * RAM is measured as the host sees it: MemAvailable, swap-in rate, memory PSI,
 * and per-Firecracker-process RSS. The balloon is reported as-is (today it only
 * inflates right before a snapshot and free-page reporting is off), so the
 * report can say what idle resident guests actually hold and what a reclaim of
 * them *would* free — without changing any behaviour.
 *
 * The parsers are pure and exported so they can be tested against fixture text
 * on any platform; the sampler itself is a no-op off Linux.
 *
 * SHO-553 added the reclaim and KSM series: per-VM `balloonedMiB` joined to the
 * Firecracker process's `VmRSS` and `ksm_merging_pages`, the host's KSM counters,
 * and the 10/30-minute per-idle-VM points the A/B/C comparison is read from.
 */

import { readFileSync, readdirSync } from 'fs'
import { hostKsm } from '../../src/host-ksm'
import { KsmdCpuTracker, findKsmdPid, parseKsmCounters, procCpuTicks } from '../../src/host-ksm'

export interface Meminfo {
  totalMiB: number
  availableMiB: number
  swapTotalMiB: number
  swapFreeMiB: number
}

export interface Pressure {
  some10: number
  some60: number
  some300: number
  full10: number
  full60: number
  full300: number
}

export interface Loadavg {
  load1: number
  load5: number
  load15: number
  procsRunning: number
  procsTotal: number
}

export interface Vmstat {
  pswpin: number
  pswpout: number
}

/**
 * What KSM is doing on this host (SHO-534 shipped it, SHO-553 has to measure
 * whether it earns its CPU). `null` on the sample means the host has no KSM
 * sysfs tree at all — a different fact from "KSM is off", which reads as
 * `run: false`.
 */
export interface KsmSample {
  /** ksmd is scanning (`/sys/kernel/mm/ksm/run`). */
  run: boolean
  /** Pages currently shared — the actual saving. */
  pagesSharing: number
  /** Pages merged at least once over the host's lifetime. */
  pagesShared: number
  /** Full scans completed; flat while VMs churn means ksmd is behind. */
  fullScans: number
  /** Sum of `/proc/<fc pid>/ksm_merging_pages` over the soak's own VMs. */
  soakMergingPages: number
  /** ksmd CPU as % of one core over `ksmdCpuWindowMs`; null until a window closes. */
  ksmdCpuPct: number | null
  ksmdCpuWindowMs: number | null
}

export interface HostSample {
  ts: number
  mem: Meminfo | null
  cpuPressure: Pressure | null
  memPressure: Pressure | null
  load: Loadavg | null
  vmstat: Vmstat | null
  /** Firecracker processes seen, and their summed RSS. */
  fcProcs: number
  fcRssMiB: number
  /** KSM counters and ksmd CPU, null when the host has no KSM. */
  ksm: KsmSample | null
  /** Per-vCPU-thread run_delay, ms of wait per second of wall clock, p50/p95/max. */
  runDelayMsPerSec: { p50: number; p95: number; max: number; threads: number } | null
  /** Swap-in pages/s since the previous sample. */
  swapInPagesPerSec: number | null
  /** MemAvailable as a percent of MemTotal. */
  memAvailablePct: number | null
}

/** The worst sample in a measurement window, which is what a bound should see. */
export interface WindowWorst {
  /** Highest `some avg60` seen in the window, percent. */
  cpuPsiSomeAvg60: number
  /** Highest `full avg60` seen in the window, percent. */
  memPsiFullAvg60: number
  /** Lowest MemAvailable seen in the window, percent of MemTotal. */
  memAvailablePct: number
  /** Mean swap-in over the window, pages/s. */
  swapInPagesPerSec: number
}

/**
 * Summarise a window by its worst sample rather than its last one.
 *
 * `memPressure.full60` is a **60-second rolling average**, so the final sample of
 * a 60 s burst window still carries most of the preceding hold inside it, and the
 * last sample of a longer step is an arbitrary point in the window. Neither is
 * the window's pressure. Taking the worst sample is the conservative reading for
 * a limit: if any sample inside the window crossed it, the window crossed it.
 */
export function windowWorst(win: HostSample[]): WindowWorst {
  if (win.length === 0) return { cpuPsiSomeAvg60: 0, memPsiFullAvg60: 0, memAvailablePct: 0, swapInPagesPerSec: 0 }
  let cpu = 0
  let mem = 0
  let avail = Infinity
  let swap = 0
  for (const s of win) {
    cpu = Math.max(cpu, s.cpuPressure?.some60 ?? 0)
    mem = Math.max(mem, s.memPressure?.full60 ?? 0)
    if (s.memAvailablePct != null) avail = Math.min(avail, s.memAvailablePct)
    swap += s.swapInPagesPerSec ?? 0
  }
  return {
    cpuPsiSomeAvg60: cpu,
    memPsiFullAvg60: mem,
    memAvailablePct: Number.isFinite(avail) ? avail : 0,
    swapInPagesPerSec: +(swap / win.length).toFixed(1),
  }
}

const num = (s: string | undefined): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/** Parse `/proc/meminfo` into MiB. */
export function parseMeminfo(text: string): Meminfo {
  const kb = (field: string) => {
    const m = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, 'm').exec(text)
    return m ? parseInt(m[1], 10) : 0
  }
  return {
    totalMiB: Math.round(kb('MemTotal') / 1024),
    availableMiB: Math.round(kb('MemAvailable') / 1024),
    swapTotalMiB: Math.round(kb('SwapTotal') / 1024),
    swapFreeMiB: Math.round(kb('SwapFree') / 1024),
  }
}

/**
 * Parse a `/proc/pressure/{cpu,memory}` file:
 *   some avg10=0.00 avg60=0.00 avg300=0.00 total=0
 *   full avg10=0.00 avg60=0.00 avg300=0.00 total=0
 */
export function parsePressure(text: string): Pressure {
  const out: Pressure = { some10: 0, some60: 0, some300: 0, full10: 0, full60: 0, full300: 0 }
  for (const line of text.split('\n')) {
    const kind = line.startsWith('some') ? 'some' : line.startsWith('full') ? 'full' : null
    if (!kind) continue
    const avg = (w: string) => num(new RegExp(`avg${w}=(\\d+(?:\\.\\d+)?)`).exec(line)?.[1])
    out[`${kind}10` as keyof Pressure] = avg('10')
    out[`${kind}60` as keyof Pressure] = avg('60')
    out[`${kind}300` as keyof Pressure] = avg('300')
  }
  return out
}

/** Parse `/proc/loadavg`: `0.52 0.58 0.59 2/1234 5678`. */
export function parseLoadavg(text: string): Loadavg {
  const p = text.trim().split(/\s+/)
  const [running, total] = (p[3] ?? '0/0').split('/')
  return {
    load1: num(p[0]),
    load5: num(p[1]),
    load15: num(p[2]),
    procsRunning: num(running),
    procsTotal: num(total),
  }
}

/** Parse the two swap counters out of `/proc/vmstat`. */
export function parseVmstat(text: string): Vmstat {
  const get = (k: string) => num(new RegExp(`^${k}\\s+(\\d+)`, 'm').exec(text)?.[1])
  return { pswpin: get('pswpin'), pswpout: get('pswpout') }
}

/**
 * Parse one `/proc/<pid>/task/<tid>/schedstat` line:
 *   <time on cpu ns> <time waiting on runqueue ns> <timeslices>
 * Returns the run_delay (field 2) in ns.
 */
export function parseSchedstat(text: string): number {
  const p = text.trim().split(/\s+/)
  return num(p[1])
}

/** Percentile of an unsorted list, nearest-rank. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[i]
}

/** PIDs of every Firecracker process on the host, from `/proc/<pid>/comm`. */
export function listFirecrackerPids(procRoot = '/proc'): number[] {
  const pids: number[] = []
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return pids
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue
    try {
      const comm = readFileSync(`${procRoot}/${e}/comm`, 'utf8').trim()
      if (comm === 'firecracker') pids.push(parseInt(e, 10))
    } catch {
      /* process exited between readdir and read */
    }
  }
  return pids
}

/** VmRSS (MiB) of one process, or 0 if it is gone. */
export function processRssMiB(pid: number, procRoot = '/proc'): number {
  try {
    const status = readFileSync(`${procRoot}/${pid}/status`, 'utf8')
    const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(status)
    return m ? Math.round(parseInt(m[1], 10) / 1024) : 0
  } catch {
    return 0
  }
}

/**
 * Every Firecracker vmId on this host, mapped to its pid.
 *
 * One walk of `/proc` for the whole fleet: the soak resolves ~160 VMs every
 * 30 s, and a per-VM scan would be 160 walks of the same tree.
 */
export function firecrackerVmIds(procRoot = '/proc'): Map<string, number> {
  const out = new Map<string, number>()
  for (const pid of listFirecrackerPids(procRoot)) {
    try {
      const argv = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0')
      const i = argv.indexOf('--id')
      if (i >= 0 && argv[i + 1]) out.set(argv[i + 1], pid)
    } catch {
      /* exited between readdir and read */
    }
  }
  return out
}

/**
 * The Firecracker pid behind a vmId.
 *
 * `/vms` reports the balloon figure per project and the RSS per host process,
 * and the report has to pair them per VM, so they need a stable join key. The
 * vmId is that key, and the one place it appears host-side is the process's own
 * argv (`firecracker --id <vmId>`).
 */
export function firecrackerPidByVmId(vmId: string, procRoot = '/proc'): number | undefined {
  return firecrackerVmIds(procRoot).get(vmId)
}

/** `/proc/<pid>/ksm_merging_pages`: pages of this process KSM has merged. */
export function ksmMergingPages(pid: number, procRoot = '/proc'): number {
  try {
    const n = Number(readFileSync(`${procRoot}/${pid}/ksm_merging_pages`, 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** Every thread id of a process. */
export function threadIds(pid: number, procRoot = '/proc'): number[] {
  try {
    return readdirSync(`${procRoot}/${pid}/task`)
      .filter((t) => /^\d+$/.test(t))
      .map((t) => parseInt(t, 10))
  } catch {
    return []
  }
}

/**
 * Sample the host. `prev` is the previous sample, used to turn the cumulative
 * swap-in counter and the cumulative per-thread run_delay into rates.
 */
export class HostSampler {
  private prev: HostSample | null = null
  private prevRunDelay = new Map<string, number>()
  private readonly ksmd = new KsmdCpuTracker()

  constructor(
    private readonly procRoot = '/proc',
    private readonly ksmRoot = '/sys/kernel/mm/ksm',
  ) {}

  /**
   * `soakPids` are the Firecracker processes this run owns. Their
   * `ksm_merging_pages` is the only per-run view of the merging — the sysfs
   * counters are host-wide, and on a host that still has tenants resident a
   * host-wide saving cannot be attributed to the soak.
   */
  sample(now = Date.now(), soakPids: number[] = []): HostSample {
    const read = (p: string): string | null => {
      try {
        return readFileSync(`${this.procRoot}/${p}`, 'utf8')
      } catch {
        return null
      }
    }

    const memText = read('meminfo')
    const mem = memText ? parseMeminfo(memText) : null
    const cpuText = read('pressure/cpu')
    const memPressureText = read('pressure/memory')
    const loadText = read('loadavg')
    const vmstatText = read('vmstat')

    const pids = listFirecrackerPids(this.procRoot)
    let fcRssMiB = 0
    for (const pid of pids) fcRssMiB += processRssMiB(pid, this.procRoot)

    // run_delay per vCPU thread, as a rate over the interval since the last
    // sample. A thread that is gone contributes nothing.
    const elapsedMs = this.prev ? Math.max(1, now - this.prev.ts) : 0
    const delays: number[] = []
    const nextRunDelay = new Map<string, number>()
    for (const pid of pids) {
      for (const tid of threadIds(pid, this.procRoot)) {
        const text = read(`${pid}/task/${tid}/schedstat`)
        if (!text) continue
        const key = `${pid}:${tid}`
        const ns = parseSchedstat(text)
        nextRunDelay.set(key, ns)
        const before = this.prevRunDelay.get(key)
        if (before !== undefined && elapsedMs > 0 && ns >= before) {
          delays.push((ns - before) / 1e6 / (elapsedMs / 1000))
        }
      }
    }
    this.prevRunDelay = nextRunDelay

    const vmstat = vmstatText ? parseVmstat(vmstatText) : null
    const swapInPagesPerSec =
      vmstat && this.prev?.vmstat && elapsedMs > 0 ? Math.max(0, (vmstat.pswpin - this.prev.vmstat.pswpin) / (elapsedMs / 1000)) : null

    const sample: HostSample = {
      ts: now,
      mem,
      cpuPressure: cpuText ? parsePressure(cpuText) : null,
      memPressure: memPressureText ? parsePressure(memPressureText) : null,
      load: loadText ? parseLoadavg(loadText) : null,
      vmstat,
      fcProcs: pids.length,
      fcRssMiB,
      ksm: this.sampleKsm(now, soakPids),
      runDelayMsPerSec:
        delays.length > 0
          ? { p50: +percentile(delays, 50).toFixed(2), p95: +percentile(delays, 95).toFixed(2), max: +Math.max(...delays).toFixed(2), threads: delays.length }
          : null,
      swapInPagesPerSec: swapInPagesPerSec === null ? null : +swapInPagesPerSec.toFixed(1),
      memAvailablePct: mem && mem.totalMiB > 0 ? +((mem.availableMiB / mem.totalMiB) * 100).toFixed(1) : null,
    }
    this.prev = sample
    return sample
  }

  /**
   * KSM counters plus ksmd's CPU on the same fixed 30 s window the agent
   * publishes as `metal_ksmd_cpu_pct` (both go through `KsmdCpuTracker`), so the
   * soak's number and the gauge mean the same thing. A KSM-less host yields
   * `null`, not a row of zeros.
   */
  private sampleKsm(now: number, soakPids: number[]): KsmSample | null {
    const counters = parseKsmCounters((file) => {
      try {
        return readFileSync(`${this.ksmRoot}/${file}`, 'utf8')
      } catch {
        return undefined
      }
    })
    if (!counters) return null

    let soakMergingPages = 0
    for (const pid of soakPids) soakMergingPages += ksmMergingPages(pid, this.procRoot)

    const out: KsmSample = { ...counters, soakMergingPages, ksmdCpuPct: null, ksmdCpuWindowMs: null }
    const ksmdPid = findKsmdPid(
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
    if (ksmdPid === undefined) return out

    let stat: string | undefined
    try {
      stat = readFileSync(`${this.procRoot}/${ksmdPid}/stat`, 'utf8')
    } catch {
      return out
    }
    const ticks = procCpuTicks(stat)
    if (ticks === undefined) return out

    const rate = this.ksmd.push({ ticks, at: now })
    out.ksmdCpuPct = rate.pct ?? null
    out.ksmdCpuWindowMs = rate.windowMs ?? null
    return out
  }
}

/** OOM kills since `since` (epoch ms), from the kernel ring buffer. */
export function oomKillsSince(since: number, journal = '/dev/kmsg'): number {
  try {
    const text = readFileSync(journal, 'utf8')
    let n = 0
    for (const line of text.split('\n')) {
      if (!/Out of memory|oom-kill|Killed process/.test(line)) continue
      const m = /^(\d+),(\d+),(\d+)/.exec(line)
      if (m) {
        const ts = parseInt(m[1], 10) * 1000
        if (ts >= since) n++
      } else {
        n++
      }
    }
    return n
  } catch {
    return 0
  }
}
