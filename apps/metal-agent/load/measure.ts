// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Metal NVMe-cache e2e measurement driver (Phase 5 GC/cache validation).
 *
 * Runs OVER THE NETWORK against a live node-agent (the same HTTP contract the
 * control plane's `metal` pod-mode uses) and answers the three questions the
 * GC/cache system exists to answer:
 *
 *   1. How much NVMe does a project take (rootfs + guest RAM + state), and how
 *      does that scale as we pile projects on — does GC keep disk bounded?
 *   2. How fast is a WARM open (resume from the local NVMe cache) vs a COLD open
 *      (the local copy was GC-evicted, so resume must pull from the durable S3
 *      tier), vs a fresh cold BOOT?
 *   3. Where is the limit — how many projects can one host cache before GC
 *      starts evicting, and does an evicted project still wake correctly?
 *
 * Flow:
 *   provision: for N unique projects, assign (cold boot) -> suspend (snapshot +
 *              durable push). Poll /vms after each to capture the storage +
 *              eviction time-series. This is what pushes the cache past its cap.
 *   wake:      re-open a sample of the OLDEST projects (most likely GC-evicted =>
 *              cold/store) and the NEWEST (still local => warm), recording
 *              host-reported readyMs bucketed by source.
 *
 * Env:
 *   BASE           node-agent base URL (default http://160.202.128.229:9900)
 *   N              projects to provision (default 60)
 *   CONCURRENCY    parallel provision workers (default 6; host throttles heavy ops)
 *   WAKE_SAMPLE    projects to re-open per bucket (default 12)
 *   PREFIX         project id prefix (default measure)
 *   OUT            results json path (default results/measure-<ts>.json)
 *   REQ_TIMEOUT_MS per-request timeout (default 240000)
 */

import { mkdirSync } from 'fs'
import { dirname } from 'path'

const BASE = process.env.BASE ?? 'http://160.202.128.229:9900'
const N = parseInt(process.env.N ?? '60', 10)
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '6', 10)
const WAKE_SAMPLE = parseInt(process.env.WAKE_SAMPLE ?? '12', 10)
const PREFIX = process.env.PREFIX ?? 'measure'
const REQ_TIMEOUT_MS = parseInt(process.env.REQ_TIMEOUT_MS ?? '240000', 10)
const RUN = new Date().toISOString().replace(/[:.]/g, '').replace('-', '').slice(0, 15)
const OUT = process.env.OUT ?? `results/measure-${RUN}.json`
const ASSIGN_ENV = { RUNTIME_AUTH_SECRET: 'loadtest', PROJECT_TIER: 'starter' }

const now = () => performance.now()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const gb = (b: number) => (b / 1e9).toFixed(2)

async function req(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; ms: number; json: any }> {
  const t0 = now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const ms = now() - t0
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* non-json */
    }
    return { ok: res.ok, status: res.status, ms, json }
  } catch (err: any) {
    return { ok: false, status: 0, ms: now() - t0, json: { error: err?.message ?? String(err) } }
  } finally {
    clearTimeout(timer)
  }
}

const assign = (pid: string) => req('POST', '/assign', { projectId: pid, env: ASSIGN_ENV })
const suspend = (pid: string) => req('POST', '/suspend', { projectId: pid })
const vms = () => req('GET', '/vms')

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length))
  return +s[i].toFixed(1)
}
function summarize(xs: number[]) {
  return xs.length ? { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: +Math.max(...xs).toFixed(1) } : { n: 0 }
}
function median(xs: number[]): number {
  return xs.length ? pct(xs, 50) : 0
}

/** Run `jobs` with a fixed worker pool preserving completion order. */
async function pool<T>(items: T[], workers: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let i = 0
  const run = async () => {
    while (i < items.length) {
      const idx = i++
      await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, run))
}

interface ProvRec {
  pid: string
  assignMs: number
  assignMode?: string
  assignSource?: string
  assignReadyMs?: number
  suspendMs: number
  suspendMemBytes?: number
  ok: boolean
  err?: string
}

async function snapshotVms(label: string) {
  const r = await vms()
  const s = r.json ?? {}
  const disk = s.disk ?? {}
  const cache = s.cache ?? {}
  const suspended: any[] = s.suspended ?? []
  const rootfsBytes = suspended.map((x) => x.rootfsBytes ?? 0).filter((x) => x > 0)
  const memBytes = suspended.map((x) => x.memBytes ?? 0).filter((x) => x > 0)
  const stateBytes = suspended.map((x) => x.stateBytes ?? 0).filter((x) => x > 0)
  return {
    label,
    ts: Date.now(),
    store: s.store,
    rootfsCow: s.rootfsCow,
    diskUsedPct: disk.usedPct,
    diskFreeGB: disk.freeBytes != null ? +gb(disk.freeBytes) : undefined,
    cacheLocalBytes: cache.localBytes ?? disk.cacheBytes,
    localCount: cache.localCount ?? suspended.length,
    perProject: {
      rootfsMedianBytes: median(rootfsBytes),
      memMedianBytes: median(memBytes),
      stateMedianBytes: median(stateBytes),
      localTotalPerProjectBytes: (cache.localBytes ?? 0) / Math.max(1, cache.localCount ?? suspended.length),
    },
  }
}

async function main() {
  console.log(`[measure] BASE=${BASE} N=${N} concurrency=${CONCURRENCY} wakeSample=${WAKE_SAMPLE}`)
  const health = await req('GET', '/healthz')
  if (!health.ok) {
    console.error(`[measure] node-agent not reachable at ${BASE}: ${JSON.stringify(health.json)}`)
    process.exit(2)
  }
  const initial = await snapshotVms('initial')
  console.log(`[measure] initial: store=${initial.store} rootfsCow=${initial.rootfsCow} disk=${initial.diskUsedPct}% localCount=${initial.localCount}`)

  const pids = Array.from({ length: N }, (_, i) => `${PREFIX}-${RUN}-${String(i).padStart(4, '0')}`)
  const prov: ProvRec[] = new Array(N)
  const series: any[] = [initial]
  let done = 0

  // --- provision: cold boot -> suspend, N unique projects ---
  const tProv = now()
  await pool(pids, CONCURRENCY, async (pid, idx) => {
    const a = await assign(pid)
    const rec: ProvRec = {
      pid,
      assignMs: a.ms,
      assignMode: a.json?.mode,
      assignSource: a.json?.source,
      assignReadyMs: a.json?.readyMs,
      suspendMs: 0,
      ok: false,
    }
    if (!a.ok) {
      rec.err = `assign ${a.status}: ${JSON.stringify(a.json).slice(0, 160)}`
      prov[idx] = rec
      done++
      return
    }
    const s = await suspend(pid)
    rec.suspendMs = s.ms
    rec.suspendMemBytes = s.json?.memBytes
    rec.ok = s.ok
    if (!s.ok) rec.err = `suspend ${s.status}: ${JSON.stringify(s.json).slice(0, 160)}`
    prov[idx] = rec
    done++
    // Sample storage roughly every 4 completed projects (and always near the end).
    if (done % 4 === 0 || done === N) {
      const snap = await snapshotVms(`after-${done}`)
      series.push(snap)
      console.log(
        `[measure] provisioned ${done}/${N} | disk=${snap.diskUsedPct}% free=${snap.diskFreeGB}GB ` +
          `local=${snap.localCount} cache=${gb(snap.cacheLocalBytes ?? 0)}GB ` +
          `perProjLocal=${gb(snap.perProject.localTotalPerProjectBytes)}GB`,
      )
    }
  })
  const provMs = now() - tProv

  // Storage picture at the end of provisioning (everything suspended), BEFORE
  // the wake phase perturbs the local/live set.
  const provEnd = await snapshotVms('provision-end')
  series.push(provEnd)

  const okProv = prov.filter((r) => r?.ok)
  const coldBootMs = okProv.map((r) => r.assignReadyMs ?? r.assignMs)
  const suspendMs = okProv.map((r) => r.suspendMs)
  const evicted = Math.max(0, okProv.length - (provEnd.localCount ?? okProv.length) + (initial.localCount ?? 0))

  // --- wake: oldest (likely evicted => cold/store) + newest (local => warm) ---
  const oldest = pids.slice(0, WAKE_SAMPLE)
  const newest = pids.slice(-WAKE_SAMPLE)
  const wake = { warm: [] as number[], cold: [] as number[], coldboot: [] as number[], hostWarm: [] as number[], hostCold: [] as number[], bySource: {} as Record<string, number> }
  const wakeRecs: any[] = []

  const doWake = async (pid: string) => {
    const a = await assign(pid)
    if (!a.ok) {
      wakeRecs.push({ pid, ok: false, err: `${a.status}` })
      return
    }
    const src = a.json?.source ?? (a.json?.mode === 'assigned' ? 'coldboot' : 'unknown')
    const ready = a.json?.readyMs ?? a.ms
    wake.bySource[src] = (wake.bySource[src] ?? 0) + 1
    if (a.json?.mode === 'resumed' && src === 'local') {
      wake.warm.push(a.ms)
      wake.hostWarm.push(ready)
    } else if (a.json?.mode === 'resumed' && src === 'store') {
      wake.cold.push(a.ms)
      wake.hostCold.push(ready)
    } else {
      wake.coldboot.push(a.ms)
    }
    wakeRecs.push({ pid, ok: true, mode: a.json?.mode, source: src, clientMs: +a.ms.toFixed(1), readyMs: ready })
    // NB: intentionally do NOT re-suspend here — a suspend re-pushes the full
    // guest-RAM snapshot to the durable store (seconds..minutes), which would
    // dominate and distort the wake-latency measurement. Woken projects are
    // left live; the idle reaper re-suspends them, and the final cleanup below
    // fire-and-forgets a suspend without timing it.
  }

  console.log(`[measure] waking ${oldest.length} oldest + ${newest.length} newest projects...`)
  // Oldest first (cold path), then newest (warm) — sequential to keep latency clean.
  for (const pid of oldest) await doWake(pid)
  for (const pid of newest) await doWake(pid)

  const final = await snapshotVms('final')
  series.push(final)

  const results = {
    run: RUN,
    base: BASE,
    config: { N, concurrency: CONCURRENCY, wakeSample: WAKE_SAMPLE, store: final.store, rootfsCow: final.rootfsCow },
    provision: {
      requested: N,
      succeeded: okProv.length,
      failed: prov.filter((r) => r && !r.ok).length,
      wallMs: +provMs.toFixed(0),
      coldBootReadyMs: summarize(coldBootMs),
      suspendMs: summarize(suspendMs),
    },
    storage: {
      rootfsMedianGB: +gb(provEnd.perProject.rootfsMedianBytes),
      memMedianGB: +gb(provEnd.perProject.memMedianBytes),
      stateMedianMB: +(provEnd.perProject.stateMedianBytes / 1e6).toFixed(2),
      localPerProjectGB: +gb(provEnd.perProject.localTotalPerProjectBytes),
      cacheLocalGB: +gb(provEnd.cacheLocalBytes ?? 0),
      localCount: provEnd.localCount,
      diskUsedPctStart: initial.diskUsedPct,
      diskUsedPctPeak: Math.max(...series.map((s) => s.diskUsedPct ?? 0)),
      diskUsedPctEnd: final.diskUsedPct,
      evictedDuringProvision: evicted,
    },
    wake: {
      warm_localCacheHit: summarize(wake.warm),
      cold_durableStorePull: summarize(wake.cold),
      coldBoot_noSnapshot: summarize(wake.coldboot),
      hostReadyMs_warm: summarize(wake.hostWarm),
      hostReadyMs_cold: summarize(wake.hostCold),
      bySource: wake.bySource,
    },
    series,
    wakeRecs,
    provErrors: prov.filter((r) => r && !r.ok).map((r) => ({ pid: r.pid, err: r.err })).slice(0, 20),
  }

  mkdirSync(dirname(OUT), { recursive: true })
  await Bun.write(OUT, JSON.stringify(results, null, 2))

  console.log('\n===== MEASUREMENT SUMMARY =====')
  console.log(`store=${final.store} rootfsCow=${final.rootfsCow}`)
  console.log(`provisioned ${okProv.length}/${N} in ${(provMs / 1000).toFixed(0)}s`)
  console.log(`cold boot ready ms: p50=${results.provision.coldBootReadyMs.p50} p95=${results.provision.coldBootReadyMs.p95}`)
  console.log(`suspend ms:         p50=${results.provision.suspendMs.p50} p95=${results.provision.suspendMs.p95}`)
  console.log(
    `storage/project: rootfs=${results.storage.rootfsMedianGB}GB mem=${results.storage.memMedianGB}GB ` +
      `localTotal=${results.storage.localPerProjectGB}GB`,
  )
  console.log(`cache: ${results.storage.cacheLocalGB}GB across ${results.storage.localCount} local; evicted=${results.storage.evictedDuringProvision}`)
  console.log(`disk used%: start=${results.storage.diskUsedPctStart} peak=${results.storage.diskUsedPctPeak} end=${results.storage.diskUsedPctEnd}`)
  console.log(`WARM open (local): ${JSON.stringify(results.wake.warm_localCacheHit)}`)
  console.log(`COLD open (store): ${JSON.stringify(results.wake.cold_durableStorePull)}`)
  console.log(`COLD boot (miss):  ${JSON.stringify(results.wake.coldBoot_noSnapshot)}`)
  console.log(`wake source mix:   ${JSON.stringify(results.wake.bySource)}`)
  console.log(`\nwrote ${OUT}`)
}

main().catch((err) => {
  console.error('[measure] fatal:', err)
  process.exit(1)
})
