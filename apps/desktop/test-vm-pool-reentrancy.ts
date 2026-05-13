#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end regression for the `reconcile()` reentrancy bug.
 *
 * The VMWarmPoolController has three independent callers that fire
 * `reconcile()`:
 *
 *   1. `start()`           — once at boot
 *   2. the 30 s setInterval — periodic
 *   3. `claim()`           — fire-and-forget after each warm-VM claim
 *
 * Pre-fix `reconcile()` was *not* reentrant. Each call saw the same
 * stale `available.size = 0` while a previous reconcile's boots were
 * still in flight, and started another full batch. With a 1-VM pool and
 * a slow real-QEMU boot (~5-30 s), three near-simultaneous reconcile
 * calls would spawn three VMs — the start of the OOM cascade.
 *
 * Post-fix the controller carries a `reconciling` flag and an
 * `inflightBoots` counter. Concurrent reconcile calls short-circuit;
 * `needed = poolSize - available.size - inflightBoots` accounts for
 * boots already in flight.
 *
 * This script asserts both behaviours with a deterministic slow-boot
 * mock and zero side effects on the host.
 *
 * Pre-fix: 5 concurrent reconcile() calls → 5 VMs booted.
 * Post-fix: 5 concurrent reconcile() calls → 1 VM booted.
 *
 * Run with:
 *   bun apps/desktop/test-vm-pool-reentrancy.ts
 */

process.env.VM_POOL_SIZE = '1'
process.env.VM_POOL_RECONCILE_INTERVAL = '999999'
process.env.VM_HEALTH_CHECK_RETRIES = '5'
process.env.VM_HEALTH_CHECK_INTERVAL = '20'
process.env.VM_IDLE_EVICTION_MS = '0'
process.env.VM_MAX_HARD_CAP = '4'

import crypto from 'crypto'
import { createServer, type Server } from 'http'

import { mock } from 'bun:test'
mock.module('../../apps/api/src/lib/runtime/build-project-env', () => ({
  buildProjectEnv: () => Promise.resolve({ PROJECT_ID: 'test' }),
}))

import {
  VMWarmPoolController,
  type VMManagerInterface,
} from '../../apps/api/src/lib/vm-warm-pool-controller'

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

const BOOT_LATENCY_MS = 500

class SlowMockVMManager implements VMManagerInterface {
  private running = new Map<string, boolean>()
  static startCount = 0
  static stopCount = 0

  async startVM(_config: any): Promise<any> {
    SlowMockVMManager.startCount++
    const id = crypto.randomUUID()
    this.running.set(id, true)
    await sleep(BOOT_LATENCY_MS)
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

let mockHealthPort = 0
let mockHealthServer: Server
function startMockServer(): Promise<void> {
  return new Promise(resolve => {
    mockHealthServer = createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200); res.end('ok'); return }
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

async function main(): Promise<void> {
  console.log('\n\x1b[1m=== VM Warm Pool Reconcile Reentrancy E2E ===\x1b[0m\n')

  await startMockServer()
  log(`Mock health server on port ${mockHealthPort}`)

  const controller = new VMWarmPoolController(
    () => new SlowMockVMManager(),
    { memoryMB: 1024 },
    1,
  )

  // -----------------------------------------------------------------------
  // Phase 1: start() boots exactly 1 VM
  // -----------------------------------------------------------------------
  await controller.start()
  log(`Pool started — startCount=${SlowMockVMManager.startCount}`)

  if (SlowMockVMManager.startCount !== 1) {
    fail('start() boots exactly one VM', `expected 1, got ${SlowMockVMManager.startCount}`)
  } else {
    pass('start() boots exactly one VM')
  }

  // -----------------------------------------------------------------------
  // Phase 2: fire 5 concurrent reconcile() calls while the pool is full.
  //          None should boot a new VM (available.size = 1 = poolSize).
  // -----------------------------------------------------------------------
  log('Firing 5 concurrent reconcile() calls against a full pool...')
  await Promise.all([
    (controller as any).reconcile(),
    (controller as any).reconcile(),
    (controller as any).reconcile(),
    (controller as any).reconcile(),
    (controller as any).reconcile(),
  ])

  if (SlowMockVMManager.startCount !== 1) {
    fail(
      'Concurrent reconciles on a full pool boot no new VMs',
      `startCount went from 1 → ${SlowMockVMManager.startCount} — REENTRANCY REGRESSION`,
    )
  } else {
    pass('Concurrent reconciles on a full pool boot no new VMs')
  }

  // -----------------------------------------------------------------------
  // Phase 3: mark the warm VM dead, then fire 5 concurrent reconcile() calls.
  //          Exactly ONE replacement should boot (not five).
  // -----------------------------------------------------------------------
  const status = controller.getStatus()
  const vmId = status.vms[0]?.vmId
  if (!vmId) { fail('warm pool has one VM after start', 'no VM in status'); }

  // Reach into internals to make the VM appear dead. Mirrors the pattern
  // in test-vm-overlay-cleanup.ts.
  const handle = (controller as any).vmHandles.get(vmId) as any
  const mgr = (controller as any).vmManagers.get(vmId) as SlowMockVMManager
  ;(mgr as any).running.set(handle.id, false)

  log('Firing 5 concurrent reconcile() calls against a pool with a dead VM...')
  const startBefore = SlowMockVMManager.startCount
  await Promise.all([
    (controller as any).reconcile(),
    (controller as any).reconcile(),
    (controller as any).reconcile(),
    (controller as any).reconcile(),
    (controller as any).reconcile(),
  ])

  const replacementBoots = SlowMockVMManager.startCount - startBefore
  if (replacementBoots !== 1) {
    fail(
      'Concurrent reconciles with a dead VM boot exactly one replacement',
      `expected 1 replacement boot, got ${replacementBoots} — REENTRANCY REGRESSION`,
    )
  } else {
    pass('Concurrent reconciles with a dead VM boot exactly one replacement')
  }

  const finalStatus = controller.getStatus()
  if (finalStatus.available !== 1) {
    fail(
      'Pool converges back to poolSize after reconciles',
      `expected available=1, got available=${finalStatus.available}`,
    )
  } else {
    pass(`Pool converges back to poolSize=1 (available: ${finalStatus.available})`)
  }

  await controller.stop()
  mockHealthServer.close()

  console.log(`\n\x1b[1mResults: ${passed}/${passed + failed} passed\x1b[0m`)
  if (failed > 0) {
    console.log(`\x1b[31m${failed} test(s) failed — reconcile reentrancy regression\x1b[0m`)
    process.exit(1)
  }
  console.log('\x1b[32mAll tests passed\x1b[0m')
  process.exit(0)
}

main().catch((err) => {
  console.error(`\n\x1b[31mFATAL:\x1b[0m ${err?.stack || err?.message || err}`)
  process.exit(1)
})
