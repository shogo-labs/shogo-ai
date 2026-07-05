// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Phase 5 concurrent-restore load test. Phases 1–3 proved a SINGLE project's
 * suspend/restore is correct and ~20x under the 2s SLO. This proves the
 * substrate holds that up under CONTENTION — many projects waking at once on a
 * single host — which is the real production shape (a region comes online, a
 * standup, a deploy fans out N project opens simultaneously).
 *
 * What it does:
 *   1. Assign N projects to microVMs (each pool-agent in its own guest), warm
 *      them, and record a per-project continuity baseline (bootID + counter).
 *   2. Suspend all N (host RAM freed → all N now cold-in-snapshot).
 *   3. For each concurrency level C in E2E_LOAD_CONCURRENCY, restore all N in
 *      waves of C IN-FLIGHT-SIMULTANEOUSLY, measuring each restore's
 *      restore→ready latency, the wall-clock, throughput (restores/s), and
 *      per-restore continuity (same bootID = live RAM, counter advanced,
 *      project survived). Re-suspend between levels so every level restores
 *      from a cold snapshot, not a hot VM.
 *   4. Gate: worst-level ready P95 < 2s, zero cold-misses, all continuity checks
 *      pass. Reports host MemAvailable delta so density is grounded in measured
 *      RAM, not the nominal per-VM figure.
 *
 * Run on the bare-metal host (root):
 *   E2E_LOAD_PROJECTS=24 E2E_LOAD_CONCURRENCY=1,4,8,16,24 bun run src/e2e-load.ts
 */

import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool } from './pool'

const N = parseInt(process.env.E2E_LOAD_PROJECTS ?? '24', 10)
const LEVELS = (process.env.E2E_LOAD_CONCURRENCY ?? '1,4,8,16,24')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => n > 0 && n <= N)
const SLO_READY_P95_MS = parseInt(process.env.E2E_LOAD_SLO_MS ?? '2000', 10)

function log(step: string, msg: string) {
  console.log(`[e2e-load] ${step.padEnd(9)} ${msg}`)
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((x, y) => x - y)
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1)
}

async function getStatus(url: string): Promise<any> {
  const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`health ${res.status}`)
  return res.json()
}

/** Host MemAvailable (MB) — measured host headroom, the real density signal. */
function memAvailableMB(): number {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)\s+kB/)
    return m ? Math.round(parseInt(m[1], 10) / 1024) : -1
  } catch {
    return -1
  }
}

/** Run `fn` over `items` with at most `c` in flight at once. */
async function withConcurrency<T, R>(items: T[], c: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(c, items.length) }, worker))
  return out
}

const projectIds = Array.from({ length: N }, (_, i) => `e2e-load-${i}`)

async function main() {
  const pool = new MetalWarmPool()
  const report: any = {
    projects: N,
    levels: LEVELS,
    config: { memMiB: config.memMiB, vcpus: config.vcpus, store: config.snapStore },
    host: { memAvailableStartMB: memAvailableMB() },
    setup: {},
    runs: [],
  }
  const baselines = new Map<string, { bootID: string; counter: number }>()

  try {
    log('pool', 'booting warm pool...')
    await pool.start()

    // ---- 1. Assign N projects (bounded concurrency to spread boot IO) --------
    log('assign', `assigning ${N} projects...`)
    let t = performance.now()
    await withConcurrency(projectIds, Math.min(8, N), async (pid) => {
      const a = await pool.assign(pid, { RUNTIME_AUTH_SECRET: 'e2e', PROJECT_TIER: 'starter' })
      return a
    })
    report.setup.assignAllMs = Math.round(performance.now() - t)
    report.host.memAvailableAllAssignedMB = memAvailableMB()
    log('assign', `all ${N} assigned in ${report.setup.assignAllMs}ms; host MemAvailable ${report.host.memAvailableAllAssignedMB}MB`)

    // Let each guest's counter advance so continuity is provable post-restore.
    await Bun.sleep(1200)
    await withConcurrency(projectIds, 16, async (pid) => {
      const a = pool.getAssigned(pid)!
      const st = await getStatus(a.handle.agentUrl)
      baselines.set(pid, { bootID: st.bootID, counter: st.counter })
    })

    // ---- 2. Suspend all → free host RAM -------------------------------------
    log('suspend', `suspending all ${N}...`)
    t = performance.now()
    for (const pid of projectIds) await pool.suspend(pid)
    report.setup.suspendAllMs = Math.round(performance.now() - t)
    report.host.memAvailableAllSuspendedMB = memAvailableMB()
    log('suspend', `all suspended in ${report.setup.suspendAllMs}ms; host MemAvailable ${report.host.memAvailableAllSuspendedMB}MB (RAM reclaimed)`)

    // ---- 3. Concurrent-restore sweep ----------------------------------------
    for (const C of LEVELS) {
      log('restore', `level C=${C}: restoring ${N} projects, ${C} in flight...`)
      const readyMs: number[] = []
      const apiMs: number[] = []
      let coldMiss = 0
      const failedContinuity: string[] = []

      const wall0 = performance.now()
      const results = await withConcurrency(projectIds, C, async (pid) => {
        const r = await pool.resume(pid)
        if (!r) {
          coldMiss++
          return null
        }
        return { pid, r }
      })
      const wallMs = performance.now() - wall0

      // Verify continuity, collect latencies, then re-suspend to reset.
      for (const item of results) {
        if (!item) continue
        const { pid, r } = item
        readyMs.push(r.readyMs)
        apiMs.push(r.apiMs)
        const base = baselines.get(pid)!
        const st = await getStatus(r.assigned.handle.agentUrl).catch(() => null)
        const ok = st && st.bootID === base.bootID && st.counter >= base.counter && st.projectId === pid
        if (!ok) failedContinuity.push(pid)
      }

      report.host[`memAvailableLevel${C}RestoredMB`] = memAvailableMB()
      // Re-suspend for the next level (skip after the last).
      for (const pid of projectIds) {
        if (pool.getAssigned(pid)) await pool.suspend(pid)
      }

      const run = {
        concurrency: C,
        restored: readyMs.length,
        coldMiss,
        continuityFailures: failedContinuity.length,
        wallMs: Math.round(wallMs),
        throughputPerSec: +(readyMs.length / (wallMs / 1000)).toFixed(1),
        peakWorkingSetMB: C * config.memMiB,
        readyMs: { p50: pct(readyMs, 50), p95: pct(readyMs, 95), p99: pct(readyMs, 99), max: +Math.max(...readyMs).toFixed(1) },
        apiMs: { p50: pct(apiMs, 50), p95: pct(apiMs, 95), p99: pct(apiMs, 99) },
      }
      report.runs.push(run)
      log(
        'restore',
        `C=${C}: ready p50=${run.readyMs.p50} p95=${run.readyMs.p95} p99=${run.readyMs.p99} max=${run.readyMs.max}ms | ` +
          `${run.throughputPerSec}/s wall=${run.wallMs}ms coldMiss=${coldMiss} contFail=${run.continuityFailures}`,
      )
    }

    // ---- 4. Gate ------------------------------------------------------------
    const worstP95 = Math.max(...report.runs.map((r: any) => r.readyMs.p95))
    const totalColdMiss = report.runs.reduce((a: number, r: any) => a + r.coldMiss, 0)
    const totalContFail = report.runs.reduce((a: number, r: any) => a + r.continuityFailures, 0)
    report.gate = {
      worstReadyP95Ms: worstP95,
      sloReadyP95Ms: SLO_READY_P95_MS,
      totalColdMiss,
      totalContinuityFailures: totalContFail,
    }
    report.pass = worstP95 < SLO_READY_P95_MS && totalColdMiss === 0 && totalContFail === 0

    console.log('\n[e2e-load] ================ RESULTS ================')
    console.log(JSON.stringify({ setup: report.setup, host: report.host, runs: report.runs, gate: report.gate, pass: report.pass }, null, 2))
    console.log('[e2e-load] ==========================================')
    console.log(
      `[e2e-load] HEADLINE ${N} projects, worst-case concurrent wake p95=${worstP95}ms (SLO ${SLO_READY_P95_MS}ms), ` +
        `coldMiss=${totalColdMiss} contFail=${totalContFail} → ${report.pass ? 'PASS' : 'FAIL'}`,
    )

    mkdirSync(config.work, { recursive: true })
    const out = join(config.work, `e2e-load-results-${new Date().toISOString().replace(/[:.]/g, '')}.json`)
    writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(`[e2e-load] wrote ${out}`)

    await pool.stop().catch(() => {})
    process.exit(report.pass ? 0 : 1)
  } catch (err: any) {
    console.error('[e2e-load] FAILED:', err?.message ?? err)
    await pool.stop().catch(() => {})
    process.exit(2)
  }
}

main()
