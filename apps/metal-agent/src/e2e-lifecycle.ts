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

import { mkdirSync, writeFileSync } from 'fs'
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
