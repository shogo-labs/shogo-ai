// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Phase 3 end-to-end test: the DURABLE snapshot lifecycle, driven through the
 * real MetalWarmPool. On top of the Phase 2 suspend/restore proof it validates
 * the three new lifecycle pieces:
 *
 *   1. quiesce/rehydrate hooks — the pool calls POST /pool/quiesce before the
 *      snapshot and POST /pool/rehydrate after the restore. We assert the guest
 *      recorded both, AND that the pre-snapshot quiesce effect was frozen into
 *      RAM and survived the round-trip (quiesceCount >= 1 after restore).
 *   2. durable store push/pull — after suspend the snapshot is pushed to the
 *      store; we then EVICT the hot local copy (simulating node-agent restart /
 *      a different host) and resume, forcing a pull from the store. A resume
 *      with source='store' proves cross-host mobility, not just same-host RAM.
 *   3. staleness guard — a pull against a mismatched rootfs identity must be
 *      rejected (null) so the caller cold-boots instead of restoring a torn VM.
 *
 * Requires the durable store enabled (METAL_SNAP_STORE=fs|s3). The bundled
 * run-lifecycle-e2e.sh wires up the fs backend on a separate path.
 *
 * Run on the bare-metal host (root):
 *   METAL_SNAP_STORE=fs bun run src/e2e-lifecycle.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool } from './pool'
import { computeRootfsIdentity, createSnapshotStore } from './snapshot-store'

const PROJECT = process.env.E2E_PROJECT_ID ?? 'e2e-lifecycle-proj'

function log(step: string, msg: string) {
  console.log(`[e2e-lc] ${step.padEnd(10)} ${msg}`)
}

async function getStatus(url: string): Promise<any> {
  const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`health ${res.status}`)
  return res.json()
}

/**
 * Guest wall clock minus the host's, in ms, read from the `Date` header the
 * guest stamps on /health. A VM restored from a snapshot must be within a
 * couple of seconds of the host — a frozen clock is the bug this covers
 * (staging 2026-10-25: a workspace resumed 4h40m behind, so the agent read the
 * wrong time and every HTTPS call from the guest failed its TLS notBefore).
 */
async function guestClockSkewMs(url: string): Promise<number> {
  const before = Date.now()
  const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
  const after = Date.now()
  const date = res.headers.get('date')
  if (!date) throw new Error('guest /health sent no Date header')
  return Date.parse(date) - Math.round((before + after) / 2)
}

/**
 * The clocksource the guest kernel settled on. Boot passes
 * `clocksource=kvm-clock` because `clock_realtime` on restore only moves
 * kvm-clock — a guest that switched to `tsc` resumes with the clock it was
 * frozen with. The guest reports the authoritative value from sysfs; the serial
 * console is the fallback for a guest that does not report it.
 */
function guestClocksource(status: any, serialLog: string | undefined): { source: string; tscSwitch: boolean } {
  let text = ''
  try {
    if (serialLog) text = readFileSync(serialLog, 'utf8')
  } catch {
    text = ''
  }
  const kvm = text.lastIndexOf('Switched to clocksource kvm-clock')
  const tsc = text.lastIndexOf('Switched to clocksource tsc')
  const reported = typeof status?.clocksource === 'string' ? status.clocksource : ''
  return {
    source: reported || (kvm !== -1 ? 'kvm-clock' : 'unknown'),
    tscSwitch: tsc !== -1 && tsc > kvm,
  }
}

async function main() {
  if (config.snapStore === 'none') {
    console.error('[e2e-lc] METAL_SNAP_STORE is "none" — set fs or s3 to exercise the durable lifecycle')
    process.exit(2)
  }

  const pool = new MetalWarmPool()
  const store = createSnapshotStore(config)
  const report: any = {
    project: PROJECT,
    store: config.snapStore,
    config: { memMiB: config.memMiB, vcpus: config.vcpus, idleSuspendMs: config.idleSuspendMs },
    steps: {},
  }

  try {
    log('pool', `booting warm pool (store=${config.snapStore})...`)
    await pool.start()

    log('assign', `assigning ${PROJECT}...`)
    const a = await pool.assign(PROJECT, { RUNTIME_AUTH_SECRET: 'e2e', PROJECT_TIER: 'starter' })
    const pre0 = await getStatus(a.handle.agentUrl)
    if (pre0.projectId !== PROJECT) throw new Error(`assign not reflected in guest: ${pre0.projectId}`)
    log('assign', `ok bootID=${pre0.bootID} counter=${pre0.counter} quiesceCount=${pre0.quiesceCount}`)

    // AC1: the cold boot we are about to snapshot must have stayed on kvm-clock,
    // or `clock_realtime` on restore cannot move its clock at all.
    const clocksource = guestClocksource(pre0, a.handle.serialLog)
    log('clock', `clocksource=${clocksource.source} later switch to tsc=${clocksource.tscSwitch}`)

    // Let the counter advance so continuity is provable.
    await Bun.sleep(1000)
    const beforeSuspend = await getStatus(a.handle.agentUrl)

    // ---- 1. quiesce + snapshot + durable push ------------------------------
    log('suspend', 'quiesce + snapshot + durable push...')
    let t = performance.now()
    const snap = await pool.suspend(PROJECT)
    report.steps.suspendMs = Math.round(performance.now() - t)
    report.snapshot = { memBytes: snap.snapshot.bytesMem, stateBytes: snap.snapshot.bytesState }
    log('suspend', `ok mem=${(snap.snapshot.bytesMem / 1e6).toFixed(0)}MB (${report.steps.suspendMs}ms)`)

    const durableMeta = await store.head(PROJECT)
    const durablePresent = durableMeta != null
    log('store', durablePresent ? `durable copy present (identity=${durableMeta!.rootfsIdentity})` : 'MISSING durable copy')

    // ---- 1b. stay suspended long enough for a frozen clock to show up -------
    // A restore that lands within the same second it was suspended cannot tell
    // a working clock from a frozen one, so hold the VM down past the 2 s
    // tolerance before waking it.
    const SUSPEND_HOLD_MS = 15_000
    log('hold', `suspended for ${SUSPEND_HOLD_MS}ms before resume...`)
    await Bun.sleep(SUSPEND_HOLD_MS)

    // ---- 2. evict hot local copy → force a durable-store pull on resume ----
    const evicted = pool.evictLocal(PROJECT)
    log('evict', `dropped hot local snapshot: ${evicted}`)
    const canResumeFromStore = await pool.canResume(PROJECT)
    log('store', `canResume after eviction (store-only): ${canResumeFromStore}`)

    log('resume', 'restoring from durable store...')
    const restored = await pool.resume(PROJECT)
    if (!restored) throw new Error('resume returned cold miss despite durable copy present')
    report.steps.resumeSource = restored.source
    report.steps.resumeApiMs = +restored.apiMs.toFixed(1)
    report.steps.resumeReadyMs = +restored.readyMs.toFixed(1)
    const afterRestore = await getStatus(restored.assigned.handle.agentUrl)
    log(
      'resume',
      `source=${restored.source} bootID=${afterRestore.bootID} counter=${afterRestore.counter} ` +
        `quiesceCount=${afterRestore.quiesceCount} rehydrateCount=${afterRestore.rehydrateCount} quiesced=${afterRestore.quiesced} ` +
        `(ready=${restored.readyMs.toFixed(1)}ms)`,
    )
    // The guest clock, read from the guest itself after the rehydrate sync. A
    // resume that hands back a clock frozen at snapshot time fails here rather
    // than silently in a TLS handshake minutes later.
    const clockSkewMs = await guestClockSkewMs(restored.assigned.handle.agentUrl)
    report.steps.suspendHoldMs = SUSPEND_HOLD_MS
    report.steps.clockSkewMs = clockSkewMs
    log('clock', `guest is ${clockSkewMs}ms from the host after a ${SUSPEND_HOLD_MS}ms suspend`)

    // ---- 3. staleness guard (store-level) ----------------------------------
    // A mismatched identity must be rejected BEFORE any artifact copy (a real
    // pull returns null → caller cold-boots). We assert the reject path with a
    // bogus identity, and the accept condition via head() so we don't clobber
    // the live rootfs the just-restored VM is running on.
    const tmpDir = join(config.snapDir, 'stale-probe')
    const staleId = `bogus-${Date.now()}`
    const stalePull = await store.pull(PROJECT, tmpDir, staleId)
    const head = await store.head(PROJECT)
    const identityMatches = head != null && head.rootfsIdentity === computeRootfsIdentity(config)
    log('stale', `mismatched-identity pull rejected: ${stalePull === null}; live identity matches (would accept): ${identityMatches}`)

    // ---- correctness -------------------------------------------------------
    const checks: Record<string, boolean> = {
      durablePushed: durablePresent,
      resumedFromStore: restored.source === 'store',
      sameBootId: afterRestore.bootID === beforeSuspend.bootID,
      counterAdvanced: afterRestore.counter >= beforeSuspend.counter,
      projectSurvived: afterRestore.projectId === PROJECT,
      quiesceHookFiredAndFrozen: afterRestore.quiesceCount >= 1,
      rehydrateHookFired: afterRestore.rehydrateCount >= 1,
      rehydrateClearedQuiesced: afterRestore.quiesced === false,
      staleSnapshotRejected: stalePull === null,
      freshSnapshotAccepted: identityMatches,
      // AC2: within 2 s of the host after a ≥ 15 s suspend. The `Date` header is
      // whole seconds and the guest corrects to whole seconds, so 2 s is the
      // tightest honest bound.
      guestClockSynced: Math.abs(clockSkewMs) <= 2000,
      // AC1: the boot that produced this snapshot pinned kvm-clock.
      guestClocksourcePinned: clocksource.source === 'kvm-clock' && !clocksource.tscSwitch,
    }
    report.correctness = { beforeSuspend, afterRestore, durableMeta, checks }
    for (const [k, v] of Object.entries(checks)) log('verify', `${k}: ${v ? 'PASS' : 'FAIL'}`)

    const allPass = Object.values(checks).every(Boolean)
    report.pass = allPass && restored.readyMs < 2000
    report.slo = { target_ready_p95_ms: 2000, actual_ready_ms: +restored.readyMs.toFixed(1) }

    console.log('\n[e2e-lc] ============== RESULTS ==============')
    console.log(JSON.stringify({ steps: report.steps, snapshot: report.snapshot, checks, slo: report.slo, pass: report.pass }, null, 2))
    console.log('[e2e-lc] ====================================')
    console.log(
      `[e2e-lc] HEADLINE durable wake source=${restored.source} ready=${restored.readyMs.toFixed(1)}ms  ` +
        `quiesce/rehydrate=${afterRestore.quiesceCount}/${afterRestore.rehydrateCount}  overall=${report.pass ? 'PASS' : 'FAIL'}`,
    )

    mkdirSync(config.work, { recursive: true })
    const out = join(config.work, `e2e-lifecycle-results-${new Date().toISOString().replace(/[:.]/g, '')}.json`)
    writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(`[e2e-lc] wrote ${out}`)

    await store.remove(PROJECT).catch(() => {})
    await pool.stop().catch(() => {})
    process.exit(report.pass ? 0 : 1)
  } catch (err: any) {
    console.error('[e2e-lc] FAILED:', err?.message ?? err)
    await pool.stop().catch(() => {})
    process.exit(2)
  }
}

main()
