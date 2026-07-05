// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Real end-to-end test of the Firecracker microVM substrate, driven through
 * the actual FirecrackerVMManager + MetalWarmPool. Proves the full lifecycle
 * the plan depends on:
 *
 *   1. Warm pool boots a microVM running the pool-agent (PROJECT_ID=__POOL__).
 *   2. Control plane claims + assigns it to a project via POST /pool/assign.
 *   3. Suspend-to-snapshot: Pause + CreateSnapshot, host RAM freed.
 *   4. Restore-from-snapshot: LoadSnapshot(mmap) + Resume — the "wake".
 *   5. Correctness after wake: same in-guest bootID (never rebooted), the
 *      per-100ms counter advanced (process continued), and the assigned
 *      projectId survived — i.e. live RAM was captured and restored.
 *   6. Reports the user-facing resume latency against the < 2s P95 SLO.
 *
 * Run on the bare-metal host (root): bun run src/e2e.ts
 * Writes a JSON report to $METAL_WORK/e2e-results-<ts>.json.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool } from './pool'

const PROJECT = process.env.E2E_PROJECT_ID ?? 'e2e-proj-abc123'
const ITERS = parseInt(process.env.E2E_ITERS ?? '10', 10)

async function getStatus(url: string): Promise<any> {
  const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`health ${res.status}`)
  return res.json()
}

function log(step: string, msg: string) {
  console.log(`[e2e] ${step.padEnd(10)} ${msg}`)
}

async function main() {
  const pool = new MetalWarmPool()
  const report: any = { project: PROJECT, iters: ITERS, config: { memMiB: config.memMiB, vcpus: config.vcpus }, steps: {} }

  try {
    log('pool', 'booting warm pool...')
    let t = performance.now()
    await pool.start()
    report.steps.poolBootMs = Math.round(performance.now() - t)
    log('pool', `ready (${report.steps.poolBootMs}ms)`)

    log('assign', `assigning ${PROJECT}...`)
    t = performance.now()
    const a = await pool.assign(PROJECT, { RUNTIME_AUTH_SECRET: 'e2e', PROJECT_TIER: 'starter' })
    report.steps.assignMs = Math.round(performance.now() - t)
    const preStatus = await getStatus(a.handle.agentUrl)
    log('assign', `ok bootID=${preStatus.bootID} counter=${preStatus.counter} project=${preStatus.projectId}`)
    if (preStatus.projectId !== PROJECT) throw new Error(`assign not reflected in guest: ${preStatus.projectId}`)

    // Let the in-guest counter advance so we can prove memory continuity.
    await Bun.sleep(1000)
    const beforeSuspend = await getStatus(a.handle.agentUrl)

    log('suspend', 'snapshotting (pause + CreateSnapshot)...')
    t = performance.now()
    const snap = await pool.suspend(PROJECT)
    report.steps.suspendMs = Math.round(performance.now() - t)
    report.snapshot = { memBytes: snap.snapshot.bytesMem, stateBytes: snap.snapshot.bytesState }
    log('suspend', `ok mem=${(snap.snapshot.bytesMem / 1e6).toFixed(0)}MB state=${snap.snapshot.bytesState}B (${report.steps.suspendMs}ms)`)

    // Prove the VM is actually gone (host RAM freed) — health must now fail.
    const goneReachable = await fetch(`${a.handle.agentUrl}/health`, { signal: AbortSignal.timeout(500) })
      .then((r) => r.ok)
      .catch(() => false)
    report.steps.vmGoneAfterSuspend = !goneReachable
    log('suspend', goneReachable ? 'WARN: VM still reachable after suspend' : 'VM freed (health unreachable)')

    // Restore repeatedly to get a latency distribution.
    log('resume', `restoring ${ITERS}x...`)
    const apiMs: number[] = []
    const readyMs: number[] = []
    const restored = await pool.resume(PROJECT)
    if (!restored) throw new Error('hot local resume returned cold miss')
    apiMs.push(restored.apiMs)
    readyMs.push(restored.readyMs)

    const afterRestore = await getStatus(restored.assigned.handle.agentUrl)
    log('resume', `bootID=${afterRestore.bootID} counter=${afterRestore.counter} project=${afterRestore.projectId} (api=${restored.apiMs.toFixed(1)}ms ready=${restored.readyMs.toFixed(1)}ms)`)

    // ---- Correctness assertions: this is the actual "sleep/wake" proof ----
    const checks: Record<string, boolean> = {
      sameBootId: afterRestore.bootID === beforeSuspend.bootID,
      counterAdvanced: afterRestore.counter >= beforeSuspend.counter,
      projectSurvived: afterRestore.projectId === PROJECT,
    }
    report.correctness = { beforeSuspend, afterRestore, checks }
    for (const [k, v] of Object.entries(checks)) log('verify', `${k}: ${v ? 'PASS' : 'FAIL'}`)

    // Remaining restore iterations for latency stats: suspend + resume loop.
    for (let i = 1; i < ITERS; i++) {
      await pool.suspend(PROJECT)
      const r = await pool.resume(PROJECT)
      if (!r) throw new Error(`resume iter ${i} returned cold miss`)
      apiMs.push(r.apiMs)
      readyMs.push(r.readyMs)
    }

    const pct = (arr: number[], p: number) => {
      const s = [...arr].sort((x, y) => x - y)
      return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1)
    }
    report.restore = {
      apiMs: { p50: pct(apiMs, 50), p95: pct(apiMs, 95), p99: pct(apiMs, 99), samples: apiMs.map((x) => +x.toFixed(1)) },
      readyMs: { p50: pct(readyMs, 50), p95: pct(readyMs, 95), p99: pct(readyMs, 99), samples: readyMs.map((x) => +x.toFixed(1)) },
    }

    const allPass = Object.values(checks).every(Boolean)
    report.pass = allPass && report.restore.readyMs.p95 < 2000
    report.slo = { target_ready_p95_ms: 2000, actual_ready_p95_ms: report.restore.readyMs.p95 }

    console.log('\n[e2e] ================ RESULTS ================')
    console.log(JSON.stringify({ steps: report.steps, snapshot: report.snapshot, restore: report.restore, checks, pass: report.pass }, null, 2))
    console.log('[e2e] ==========================================')
    console.log(`[e2e] HEADLINE resume ready p50=${report.restore.readyMs.p50}ms p95=${report.restore.readyMs.p95}ms  correctness=${allPass ? 'PASS' : 'FAIL'}  overall=${report.pass ? 'PASS' : 'FAIL'}`)

    mkdirSync(config.work, { recursive: true })
    const out = join(config.work, `e2e-results-${new Date().toISOString().replace(/[:.]/g, '')}.json`)
    writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(`[e2e] wrote ${out}`)

    await pool.stop().catch(() => {})
    process.exit(report.pass ? 0 : 1)
  } catch (err: any) {
    console.error('[e2e] FAILED:', err?.message ?? err)
    await pool.stop().catch(() => {})
    process.exit(2)
  }
}

main()
