#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end regression for the warm-pool concurrent-spawn OOM bug.
 *
 * Symptom (the bug this test exists to catch):
 *   "the local vm mode just keeps spawning VMs until the computer runs
 *    out of memory and crashes"
 *
 * Root cause: `_assignProject` did `while (assigned.size >= maxAssigned)`
 * *before* awaiting `bootVM`. While the boot was in flight, the count
 * stayed stale, so concurrent calls for *different* project IDs all
 * passed the cap check and all booted a fresh QEMU. Open 20 projects
 * in quick succession (or have the UI fan out 20 cold-start requests in
 * parallel — see `getProjectUrl` callers in project-chat / agent-proxy /
 * sandbox-url) and you get 20 QEMUs × ~4 GB each before the cap engages.
 *
 * This script reproduces the race deterministically with a slow mock
 * VMManager and asserts the controller never holds more than
 * `maxAssigned + poolSize + 1` *live* VMs at any point during the burst.
 *
 * Pre-fix this test boots 20 VMs and trips the assertion.
 * Post-fix the live count stays at ≤ maxAssigned + poolSize at all times.
 *
 * Run with:
 *   bun apps/desktop/test-vm-pool-concurrency.ts
 */

// Tune the warm pool for fast deterministic test execution BEFORE importing
// the controller. `import` statements are hoisted in ESM, so the
// controller module loads — and reads `process.env.VM_*` into its
// module-level constants — *before* any non-import statements run. We
// dynamic-import the controller below in main() once these env vars are
// set so VM_MAX_ASSIGNED etc. actually take effect.
process.env.VM_POOL_SIZE = '1'
process.env.VM_POOL_RECONCILE_INTERVAL = '999999'
process.env.VM_HEALTH_CHECK_RETRIES = '5'
process.env.VM_HEALTH_CHECK_INTERVAL = '20'
process.env.VM_IDLE_EVICTION_MS = '0'
process.env.VM_MAX_HARD_CAP = '4'
process.env.VM_MAX_ASSIGNED = '2'

import crypto from 'crypto'
import { createServer, type Server } from 'http'
import type { VMManagerInterface } from '../../apps/api/src/lib/vm-warm-pool-controller'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${msg}`)
}
function pass(name: string): void { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
function fail(name: string, err?: any): void { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`) }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

// ---------------------------------------------------------------------------
// Slow mock VM manager — the key to reproducing the race
// ---------------------------------------------------------------------------

const BOOT_LATENCY_MS = 300

class SlowMockVMManager implements VMManagerInterface {
  private running = new Map<string, boolean>()

  static startCount = 0
  static stopCount = 0
  /** Maximum concurrent live VMs observed across this run. */
  static maxLive = 0

  static currentLive(): number {
    return SlowMockVMManager.startCount - SlowMockVMManager.stopCount
  }

  async startVM(_config: any): Promise<any> {
    SlowMockVMManager.startCount++
    SlowMockVMManager.maxLive = Math.max(SlowMockVMManager.maxLive, SlowMockVMManager.currentLive())
    const id = crypto.randomUUID()
    this.running.set(id, true)
    await sleep(BOOT_LATENCY_MS) // <-- slow startVM is what creates the race window
    return {
      id,
      agentUrl: `http://localhost:${mockHealthPort}`,
      skillServerPort: 0,
      pid: process.pid,
      platform: 'darwin' as const,
    }
  }

  async stopVM(handle: any): Promise<void> {
    if (this.running.get(handle.id)) {
      SlowMockVMManager.stopCount++
      this.running.set(handle.id, false)
    }
  }

  isRunning(handle: any): boolean { return this.running.get(handle.id) ?? false }
  async forwardPort(): Promise<void> {}
  async removeForward(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Mock health server (responds 200 to /health AND 200 to /pool/assign)
// ---------------------------------------------------------------------------

let mockHealthPort = 0
let mockHealthServer: Server

function startMockServer(): Promise<void> {
  return new Promise(resolve => {
    mockHealthServer = createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200); res.end('ok'); return }
      if (req.url === '/pool/assign') {
        // Drain body to keep node happy, then 200 OK.
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
        return
      }
      res.writeHead(404); res.end()
    })
    mockHealthServer.listen(0, '127.0.0.1', () => {
      const addr = mockHealthServer.address()
      mockHealthPort = typeof addr === 'object' ? addr!.port : 0
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// Stub buildProjectEnv so tests don't touch Prisma
// ---------------------------------------------------------------------------

import { mock } from 'bun:test'
mock.module('../../apps/api/src/lib/runtime/build-project-env', () => ({
  buildProjectEnv: () => Promise.resolve({ PROJECT_ID: 'test' }),
}))

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n\x1b[1m=== VM Warm Pool Concurrency E2E ===\x1b[0m\n')

  await startMockServer()
  log(`Mock health server on port ${mockHealthPort}`)
  log(`Boot latency: ${BOOT_LATENCY_MS}ms per VM`)

  const { VMWarmPoolController } = await import(
    '../../apps/api/src/lib/vm-warm-pool-controller'
  )

  const POOL_SIZE = 1
  const MAX_ASSIGNED = 2
  const PROJECT_COUNT = 20
  // Each assigned VM, plus the warm-pool replenishment, plus a tolerance of
  // 1 for the inherent gap between `claim()` and assigned-map insert.
  // Anything above this is a regression.
  const LIVE_LIMIT = MAX_ASSIGNED + POOL_SIZE + 1

  const controller = new VMWarmPoolController(
    () => new SlowMockVMManager(),
    { memoryMB: 1024 },
    POOL_SIZE,
  )
  log(`Controller status: ${JSON.stringify(controller.getStatus())}`)

  // ---------------------------------------------------------------------------
  // Poll live VM count while the burst runs. Without polling we'd only catch
  // the steady-state cap violation; the race spikes the live count
  // temporarily and then converges, which is exactly the OOM trigger.
  // ---------------------------------------------------------------------------
  let polling = true
  let pollMaxLive = 0
  let pollMaxAssigned = 0
  let pollMaxAssignedPlusInflight = 0
  let liveLimitBreached = false
  ;(async () => {
    while (polling) {
      const live = SlowMockVMManager.currentLive()
      pollMaxLive = Math.max(pollMaxLive, live)
      if (live > LIVE_LIMIT) liveLimitBreached = true

      const status = controller.getStatus()
      pollMaxAssigned = Math.max(pollMaxAssigned, status.assigned)
      pollMaxAssignedPlusInflight = Math.max(
        pollMaxAssignedPlusInflight,
        status.assigned + (status.inflightBoots ?? 0),
      )
      await sleep(25)
    }
  })()

  await controller.start()
  log(`Pool started — available: ${controller.getStatus().available}, max: ${controller.getStatus().maxAssigned}`)

  // -------------------------------------------------------------------------
  // The burst — 20 concurrent getProjectUrl calls for distinct projects.
  // This is what fries the host pre-fix.
  // -------------------------------------------------------------------------
  log(`Firing ${PROJECT_COUNT} concurrent getProjectUrl calls...`)
  const t0 = Date.now()
  const results = await Promise.allSettled(
    Array.from({ length: PROJECT_COUNT }, (_, i) =>
      controller.getProjectUrl(`proj-${i}`),
    ),
  )
  const burstMs = Date.now() - t0
  log(`Burst complete in ${burstMs}ms`)

  // Give the post-claim reconcile / async stopVM calls a chance to settle.
  await sleep(500)
  polling = false

  const succeeded = results.filter(r => r.status === 'fulfilled').length
  log(`getProjectUrl results: ${succeeded}/${PROJECT_COUNT} succeeded`)

  // -------------------------------------------------------------------------
  // Assertions
  // -------------------------------------------------------------------------
  if (liveLimitBreached) {
    fail(
      'Live VM count stays within cap',
      `pollMaxLive=${pollMaxLive} exceeded LIVE_LIMIT=${LIVE_LIMIT} — RUNAWAY SPAWN REGRESSION`,
    )
  } else {
    pass(`Live VM count stayed within cap (max observed: ${pollMaxLive}, limit: ${LIVE_LIMIT})`)
  }

  if (pollMaxAssigned > MAX_ASSIGNED) {
    fail(
      'controller.getStatus().assigned never exceeds maxAssigned',
      `observed ${pollMaxAssigned} > ${MAX_ASSIGNED}`,
    )
  } else {
    pass(`controller.getStatus().assigned stayed ≤ ${MAX_ASSIGNED} (max: ${pollMaxAssigned})`)
  }

  const finalStatus = controller.getStatus()
  if (finalStatus.assigned !== MAX_ASSIGNED) {
    fail('Final assigned count equals cap', `expected ${MAX_ASSIGNED}, got ${finalStatus.assigned}`)
  } else {
    pass(`Final assigned count is exactly ${MAX_ASSIGNED}`)
  }

  // Total VMs started should be bounded. Each LRU eviction triggers a fresh
  // boot for the next claim, so PROJECT_COUNT - poolSize is the worst-case
  // *valid* number. The bug was unbounded — we cap the regression test at
  // PROJECT_COUNT + 2 (gives a little slack for the warm-pool replenishment).
  const totalStarts = SlowMockVMManager.startCount
  if (totalStarts > PROJECT_COUNT + 2) {
    fail('Total VM starts is bounded', `${totalStarts} starts for ${PROJECT_COUNT} projects`)
  } else {
    pass(`Total VM starts is bounded (${totalStarts} starts for ${PROJECT_COUNT} projects)`)
  }

  await controller.stop()
  mockHealthServer.close()

  console.log(`\n\x1b[1mResults: ${passed}/${passed + failed} passed\x1b[0m`)
  if (failed > 0) {
    console.log(`\x1b[31m${failed} test(s) failed — runaway-spawn regression\x1b[0m`)
    process.exit(1)
  }
  console.log('\x1b[32mAll tests passed\x1b[0m')
  process.exit(0)
}

main().catch((err) => {
  console.error(`\n\x1b[31mFATAL:\x1b[0m ${err?.stack || err?.message || err}`)
  process.exit(1)
})
