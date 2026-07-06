// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Phase 5 end-to-end test: NVMe-as-cache behavior on a real Firecracker host.
 * Builds on e2e-lifecycle.ts (which proves the durable suspend/restore) and
 * asserts the GC/cache guarantees:
 *
 *   1. restart keeps locality — a fresh pool over the same NVMe rehydrates the
 *      suspended index and resumes from the LOCAL snapshot (source='local'),
 *      i.e. a node-agent deploy does not dump the cache to a store re-pull.
 *   2. disk-pressure eviction is safe — a forced GC sweep evicts the durably-
 *      backed suspended project, and it still resumes afterwards from the store
 *      (source='store'): the cache-miss path.
 *   3. concurrent opens dedupe — N simultaneous open() for one project produce
 *      exactly one live VM (singleflight), never a stampede of cold boots.
 *   4. orphan reclaim — a stray artifact left on NVMe is reclaimed.
 *
 * Requires the durable store enabled (METAL_SNAP_STORE=fs|s3), same as
 * e2e-lifecycle. Run on the bare-metal host (root):
 *   METAL_SNAP_STORE=fs bun run src/e2e-gc.ts
 */

import { writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool } from './pool'

const PROJECT = process.env.E2E_PROJECT_ID ?? 'e2e-gc-proj'

function log(step: string, msg: string) {
  console.log(`[e2e-gc] ${step.padEnd(12)} ${msg}`)
}

async function main() {
  if (config.snapStore === 'none') {
    console.error('[e2e-gc] METAL_SNAP_STORE is "none" — set fs or s3 to exercise the cache lifecycle')
    process.exit(2)
  }

  const checks: Record<string, boolean> = {}
  const pool = new MetalWarmPool()

  try {
    log('pool', `booting warm pool (store=${config.snapStore}, rootfsCow=${config.rootfsCow})...`)
    await pool.start()

    log('assign', `assigning ${PROJECT}...`)
    await pool.assign(PROJECT, { RUNTIME_AUTH_SECRET: 'e2e' })
    await Bun.sleep(500)

    log('suspend', 'suspend + durable push...')
    await pool.suspend(PROJECT)

    // ---- 1. restart keeps locality ---------------------------------------
    // A brand-new pool over the SAME NVMe simulates a node-agent restart/deploy.
    const pool2 = new MetalWarmPool()
    const rehydrated = pool2.rehydrate()
    log('restart', `rehydrated ${rehydrated} suspended snapshot(s) from index`)
    checks.rehydratedFromIndex = rehydrated >= 1

    const localResume = await pool2.resume(PROJECT)
    checks.restartLocalResume = localResume?.source === 'local'
    log('restart', `resume after restart: source=${localResume?.source} ready=${localResume?.readyMs?.toFixed(1)}ms`)

    // ---- 2. disk-pressure eviction + store-backed resume -----------------
    await pool2.suspend(PROJECT)
    const forced = await pool2.gcSweep({ force: true })
    checks.forcedEviction = forced.evicted.includes(PROJECT)
    log('evict', `forced gc evicted=[${forced.evicted.join(',')}] reclaimed=${(forced.bytesReclaimed / 1e6).toFixed(0)}MB`)

    const canResumeAfterEvict = await pool2.canResume(PROJECT)
    checks.canResumeAfterEvict = canResumeAfterEvict
    const storeResume = await pool2.resume(PROJECT)
    checks.storeResumeAfterEvict = storeResume?.source === 'store'
    log('evict', `resume after eviction: source=${storeResume?.source} ready=${storeResume?.readyMs?.toFixed(1)}ms`)

    // ---- 3. concurrent opens dedupe --------------------------------------
    await pool2.suspend(PROJECT)
    const opens = await Promise.all(Array.from({ length: 5 }, () => pool2.open(PROJECT)))
    const distinctVms = new Set(opens.map((o) => o.handle.id))
    checks.concurrentDedupe = distinctVms.size === 1
    log('concurrent', `5 concurrent open() → ${distinctVms.size} distinct VM(s) (expect 1)`)

    // ---- 4. orphan reclaim -----------------------------------------------
    const junk = join(config.snapDir, 'orphan-junk.vmstate')
    writeFileSync(junk, 'junk')
    const removed = pool2.reclaimOrphans()
    checks.orphanReclaimed = removed >= 1
    log('orphan', `reclaimed ${removed} orphan artifact(s)`)

    for (const [k, v] of Object.entries(checks)) log('verify', `${k}: ${v ? 'PASS' : 'FAIL'}`)
    const pass = Object.values(checks).every(Boolean)
    console.log(`\n[e2e-gc] HEADLINE overall=${pass ? 'PASS' : 'FAIL'}`)

    await pool2.stop().catch(() => {})
    await pool.stop().catch(() => {})
    process.exit(pass ? 0 : 1)
  } catch (err: any) {
    console.error('[e2e-gc] FAILED:', err?.message ?? err)
    await pool.stop().catch(() => {})
    process.exit(2)
  }
}

main()
