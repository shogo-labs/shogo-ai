// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Recycle and API-watchdog end-to-end test on real Firecracker microVMs,
 * driven through the real MetalWarmPool with the stub guest
 * (guest/pool-agent.go, which reports whatever API health and agent-turn count
 * it is told to via POST /e2e/state).
 *
 *   1. recycle of a SUSPENDED runtime resumes it, runs the backups from the
 *      live guest, then stops it without a snapshot: the local and durable
 *      snapshots are gone and the next open cannot resume the old VM.
 *   2. recycle refuses while an agent turn is in flight, removes nothing, and
 *      the VM keeps serving.
 *   3. watchdog in observe mode notices a crashed API server past the
 *      threshold and leaves the VM alone.
 *   4. watchdog in enforce mode recycles the same runtime; a second attempt
 *      inside the hour is rate-limited.
 *
 * Requires the durable store (METAL_SNAP_STORE=fs|s3) so step 1 can prove the
 * durable copy is dropped. Run on the bare-metal host (root) via
 * scripts/metal-agent/run-lifecycle-e2e.sh with E2E=recycle, or:
 *   METAL_SNAP_STORE=fs bun run src/e2e-recycle.ts
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool } from './pool'
import { createSnapshotStore } from './snapshot-store'

const RUN = Date.now().toString(36)
const SUSPENDED = `e2e-recycle-susp-${RUN}`
const BUSY = `e2e-recycle-busy-${RUN}`
const CRASHED = `e2e-recycle-crash-${RUN}`
const THRESHOLD_MS = 3000
const ENV = { RUNTIME_AUTH_SECRET: 'e2e', PROJECT_TIER: 'starter' }

function log(step: string, msg: string) {
  console.log(`[e2e-rc] ${step.padEnd(10)} ${msg}`)
}

async function setGuest(url: string, state: { apiPhase?: string; activeStreams?: number }) {
  const res = await fetch(`${url}/e2e/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
    signal: AbortSignal.timeout(2000),
  })
  if (!res.ok) throw new Error(`guest /e2e/state ${res.status} (rootfs has an old pool-agent?)`)
}

async function alive(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}

async function main() {
  if (config.snapStore === 'none') {
    console.error('[e2e-rc] METAL_SNAP_STORE is "none" — set fs or s3 so the durable snapshot drop is checked')
    process.exit(2)
  }
  const cfg = { ...config, activityPoll: true, apiUnhealthyRecycleMs: THRESHOLD_MS }
  const pool = new MetalWarmPool(undefined, { ...cfg, apiWatchdogMode: 'observe' })
  const store = createSnapshotStore(config)
  const checks: Record<string, boolean> = {}
  const report: Record<string, unknown> = { run: RUN, store: config.snapStore }

  try {
    log('pool', `booting warm pool (store=${config.snapStore})...`)
    await pool.start()

    // ---- 1. recycle a suspended runtime ------------------------------------
    log('suspend', `assign + suspend ${SUSPENDED}...`)
    await pool.assign(SUSPENDED, ENV)
    await pool.suspend(SUSPENDED)
    checks.durableSnapshotBefore = (await store.head(SUSPENDED)) != null
    const r1 = await pool.recycle(SUSPENDED, { reason: 'e2e', env: ENV })
    report.recycleSuspended = r1
    log('recycle', `aborted=${r1.aborted} resumed=${r1.resumed} steps=${r1.steps.map((s) => `${s.step}:${s.ok}`).join(',')}`)
    checks.recycleSucceeded = !r1.aborted
    checks.recycleResumedFirst = r1.resumed && r1.steps[0]?.step === 'resume'
    checks.recycleRanBackups = ['repo', 'source', 'data'].every((s) => r1.steps.some((x) => x.step === s && x.ok))
    checks.durableSnapshotDropped = (await store.head(SUSPENDED)) == null
    checks.noLongerResumable = !(await pool.canResume(SUSPENDED))
    checks.runtimeGone = pool.getProjectStatus(SUSPENDED).state === 'none'

    // ---- 2. an agent turn in flight blocks recycle -------------------------
    log('busy', `assign ${BUSY}, report an agent turn in flight...`)
    const busy = await pool.assign(BUSY, ENV)
    await setGuest(busy.handle.agentUrl, { activeStreams: 1 })
    await pool.pollActivity()
    const r2 = await pool.recycle(BUSY, { reason: 'e2e' })
    report.recycleBusy = r2
    checks.busyRecycleRefused = r2.aborted && r2.steps.some((s) => s.step === 'idle' && !s.ok)
    checks.busyVmStillServing = await alive(busy.handle.agentUrl)
    await setGuest(busy.handle.agentUrl, { activeStreams: 0 })
    await pool.pollActivity()
    checks.idleRecycleSucceeds = !(await pool.recycle(BUSY, { reason: 'e2e' })).aborted

    // ---- 3. watchdog, observe mode -----------------------------------------
    log('observe', `assign ${CRASHED}, report a crashed API server...`)
    const crashed = await pool.assign(CRASHED, ENV)
    await setGuest(crashed.handle.agentUrl, { apiPhase: 'crashed' })
    await pool.pollActivity()
    await Bun.sleep(THRESHOLD_MS + 500)
    await pool.pollActivity()
    checks.observeRecyclesNothing = (await pool.autoRecycleUnhealthy()).length === 0
    checks.observeVmStillServing = await alive(crashed.handle.agentUrl)

    // ---- 4. watchdog, enforce mode -----------------------------------------
    ;(pool as any).cfg = { ...(pool as any).cfg, apiWatchdogMode: 'enforce' }
    const recycled = await pool.autoRecycleUnhealthy()
    log('enforce', `recycled: ${recycled.join(', ') || 'none'}`)
    checks.enforceRecycled = recycled.length === 1 && recycled[0] === CRASHED
    checks.enforceRuntimeGone = pool.getProjectStatus(CRASHED).state === 'none'

    const again = await pool.assign(CRASHED, ENV)
    await setGuest(again.handle.agentUrl, { apiPhase: 'crashed' })
    await pool.pollActivity()
    await Bun.sleep(THRESHOLD_MS + 500)
    await pool.pollActivity()
    checks.secondAttemptRateLimited = (await pool.autoRecycleUnhealthy()).length === 0
    await setGuest(again.handle.agentUrl, { apiPhase: 'healthy' })
    await pool.pollActivity()
    checks.healthyClearsUnhealthy = pool.status().assigned.every((a: any) => a.apiUnhealthyMs === null)

    for (const [k, v] of Object.entries(checks)) log('verify', `${k}: ${v ? 'PASS' : 'FAIL'}`)
    const pass = Object.values(checks).every(Boolean)
    console.log('\n[e2e-rc] ============== RESULTS ==============')
    console.log(JSON.stringify({ checks, pass }, null, 2))
    console.log(`[e2e-rc] HEADLINE recycle + watchdog overall=${pass ? 'PASS' : 'FAIL'}`)

    mkdirSync(config.work, { recursive: true })
    const out = join(config.work, `e2e-recycle-results-${new Date().toISOString().replace(/[:.]/g, '')}.json`)
    writeFileSync(out, JSON.stringify({ ...report, checks, pass }, null, 2))
    console.log(`[e2e-rc] wrote ${out}`)

    for (const id of [SUSPENDED, BUSY, CRASHED]) await pool.destroy(id).catch(() => {})
    await pool.stop().catch(() => {})
    process.exit(pass ? 0 : 1)
  } catch (err: any) {
    console.error('[e2e-rc] FAILED:', err?.message ?? err)
    for (const id of [SUSPENDED, BUSY, CRASHED]) await pool.destroy(id).catch(() => {})
    await pool.stop().catch(() => {})
    process.exit(2)
  }
}

main()
