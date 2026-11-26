// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The agent's own memory, attributed.
 *
 * The 2026-11-26 incident (SHO-593) was a 53 GiB `VmHWM` with nothing in the
 * journal to explain it: the kernel OOM-killed a process whose RSS had gone from
 * 0.2 GiB to 40 GiB in minutes and back, and every candidate — a guest export,
 * an S3 object, a snapshot upload — looked equally plausible from the code. A
 * host-side sampler can only say *when* it happened.
 *
 * So this tracks the operations that hold a whole object in memory while they
 * run, and reports, while RSS is over a threshold, what is in flight with its
 * size and age. Two independent readings are logged on purpose:
 *
 *   - `rss` from `process.memoryUsage()` is the same number /proc reports;
 *   - `external` / `arrayBuffers` split it into native buffers vs the JS heap.
 *     A burst of anonymous memory that is `arrayBuffers` is a buffered object
 *     (an export or an S3 read); a burst that is `heapUsed` is JS objects; a
 *     burst in neither is the allocator or the HTTP layer, and the call site
 *     list then shows what was running at the time.
 *
 * `begin`/`end` are cheap enough to leave on (a Map write each), and a site that
 * is never ended would be a lie, so every caller uses the returned closer in a
 * `finally`. Nothing here allocates per sample beyond the log line itself, which
 * only happens above the threshold.
 */

export interface MemSample {
  rss: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

export interface InFlightSite {
  kind: string
  /** What the hold belongs to: a VM id, a project id, an S3 key. */
  label: string
  /** Epoch ms the hold began. */
  startedAt: number
  /** Bytes the site believes it is holding; 0 until it knows (a stream has no length). */
  bytes: number
}

export interface MemProbeOptions {
  /** Log a `[mem]` line while RSS is at or above this. 0 disables logging. */
  thresholdBytes?: number
  /** How often to sample for the log. */
  intervalMs?: number
  sample?: () => MemSample
  log?: (line: string) => void
  now?: () => number
}

const MIB = 1024 * 1024

function defaultSample(): MemSample {
  const m = process.memoryUsage()
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers ?? 0 }
}

export class MemProbe {
  private readonly sites = new Map<number, InFlightSite>()
  private nextId = 1
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly thresholdBytes: number
  private readonly intervalMs: number
  private readonly sample: () => MemSample
  private readonly log: (line: string) => void
  private readonly now: () => number
  /** Highest RSS seen by the sampler, for the gauge and the log. */
  peakRss = 0

  constructor(opts: MemProbeOptions = {}) {
    this.thresholdBytes = opts.thresholdBytes ?? 4096 * MIB
    this.intervalMs = opts.intervalMs ?? 5000
    this.sample = opts.sample ?? defaultSample
    this.log = opts.log ?? ((line) => console.log(line))
    this.now = opts.now ?? Date.now
  }

  /** Register a hold. Returns an id for {@link end}; the call itself never throws. */
  begin(kind: string, label = ''): number {
    const id = this.nextId++
    this.sites.set(id, { kind, label, startedAt: this.now(), bytes: 0 })
    return id
  }

  /** Close a hold, recording how many bytes it ended up moving (if known). */
  end(id: number, bytes?: number): void {
    if (bytes !== undefined) {
      const site = this.sites.get(id)
      if (site) site.bytes = bytes
    }
    this.sites.delete(id)
  }

  /**
   * Record how much an OPEN hold is carrying, as soon as that is known — a
   * `content-length`, a stat, a running total of parts. Without this a site can
   * only report its size after it ends, which is exactly the moment the log line
   * no longer needs it.
   */
  held(id: number, bytes: number): void {
    const site = this.sites.get(id)
    if (site && Number.isFinite(bytes) && bytes > 0) site.bytes = bytes
  }

  /** Snapshot of what is in flight right now, largest first. */
  inFlight(): InFlightSite[] {
    return [...this.sites.values()].sort((a, b) => b.bytes - a.bytes)
  }

  count(): number {
    return this.sites.size
  }

  clear(): void {
    this.sites.clear()
  }

  /**
   * One line, shaped for `journalctl | grep '\[mem\]'` and for joining against
   * the pool's own log lines on the second.
   */
  line(sample: MemSample = this.sample()): string {
    this.peakRss = Math.max(this.peakRss, sample.rss)
    const sites = this.inFlight()
    const byKind = new Map<string, number>()
    for (const s of sites) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1)
    const kinds = [...byKind].map(([k, n]) => `${k}:${n}`).join(',') || 'none'
    const top = sites
      .slice(0, 6)
      .map((s) => {
        const age = ((this.now() - s.startedAt) / 1000).toFixed(1)
        const held = s.bytes ? `${Math.round(s.bytes / MIB)}MiB` : 'unknown'
        const label = s.label ? ` ${s.label}` : ''
        return `${s.kind}(${held},${age}s${label})`
      })
      .join(' ')
    return (
      `[mem] rss=${Math.round(sample.rss / MIB)}MiB peak=${Math.round(this.peakRss / MIB)}MiB ` +
      `heap=${Math.round(sample.heapUsed / MIB)}MiB external=${Math.round(sample.external / MIB)}MiB ` +
      `arrayBuffers=${Math.round(sample.arrayBuffers / MIB)}MiB inflight=${sites.length} by_kind=${kinds}` +
      (top ? ` top=${top}` : '')
    )
  }

  /** Sample once; logs only above the threshold. Returns the sample (for gauges). */
  tick(): MemSample {
    const sample = this.read()
    if (this.thresholdBytes > 0 && sample.rss >= this.thresholdBytes) this.log(this.line(sample))
    return sample
  }

  /** Current numbers, updating the peak. Never logs. */
  read(): MemSample {
    const sample = this.sample()
    this.peakRss = Math.max(this.peakRss, sample.rss)
    return sample
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    // Never hold the process open for a diagnostic timer.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/**
 * The process-wide probe. `METAL_MEM_LOG_MIB` (default 4096) is the RSS above
 * which a `[mem]` line is worth a journal entry on every sample; 0 turns the
 * logging off and leaves the gauges.
 */
export const memProbe = new MemProbe({
  thresholdBytes: Math.max(0, parseInt(process.env.METAL_MEM_LOG_MIB ?? '4096', 10) || 0) * MIB,
  intervalMs: Math.max(1000, parseInt(process.env.METAL_MEM_LOG_INTERVAL_MS ?? '5000', 10) || 5000),
})
