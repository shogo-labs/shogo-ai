#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end regression for the VM warm pool's host-memory cap.
 *
 * The runaway-spawn bug is reproduced here against real QEMU VMs to
 * prove the controller's cap actually holds when the production
 * `DarwinVMManager` / `Win32VMManager` is plugged in (not just against
 * our mock). Each VM is sized down to 1 GB so an 8 GB host can boot up
 * to the cap without thrashing.
 *
 * Opt-in: requires RUN_VM_E2E=1 and the bundled VM images at
 *   apps/desktop/resources/vm/{vmlinuz,initrd.img,rootfs-provisioned.qcow2}
 *
 * Assertions:
 *   1. `pgrep qemu-system-*` peak count ≤ poolSize + maxAssigned during
 *      a burst of N >> cap concurrent project assignments.
 *   2. controller.getStatus().assigned === maxAssigned after burst.
 *   3. After controller.stop(), `pgrep qemu-system-*` returns 0.
 *
 * Pre-fix: this test boots PROJECT_COUNT QEMUs and trips assertion 1.
 *
 * Run with:
 *   RUN_VM_E2E=1 bun apps/desktop/test-vm-pool-host-cap.ts
 */

import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

// -----------------------------------------------------------------------
// Opt-in gating
// -----------------------------------------------------------------------

if (process.env.RUN_VM_E2E !== '1') {
  console.log('Skipping real-QEMU e2e — set RUN_VM_E2E=1 to run.')
  process.exit(0)
}

const POOL_SIZE = 1
const MAX_ASSIGNED = 2
const PROJECT_COUNT = 6
const VM_MEMORY_MB = 1024

// Configure the pool BEFORE importing the controller — env vars are
// captured at module load time.
process.env.VM_POOL_SIZE = String(POOL_SIZE)
process.env.VM_MAX_ASSIGNED = String(MAX_ASSIGNED)
process.env.VM_MAX_HARD_CAP = String(MAX_ASSIGNED)
process.env.VM_MEMORY_MB = String(VM_MEMORY_MB)
process.env.VM_POOL_RECONCILE_INTERVAL = '999999'
process.env.VM_IDLE_EVICTION_MS = '0'

const DESKTOP_DIR = path.dirname(new URL(import.meta.url).pathname)
const VM_IMAGE_DIR = path.join(DESKTOP_DIR, 'resources', 'vm')
const OVERLAY_DIR = '/tmp/shogo-vm-pool-host-cap-test'

// Stub buildProjectEnv before the controller imports it. /pool/assign
// would otherwise hit Prisma to fetch the project row.
import { mock } from 'bun:test'
mock.module('../api/src/lib/runtime/build-project-env', () => ({
  buildProjectEnv: () => Promise.resolve({ PROJECT_ID: 'test' }),
}))

process.env.SHOGO_VM_IMAGE_DIR = VM_IMAGE_DIR

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

let passed = 0
let failed = 0
function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${msg}`)
}
function pass(name: string): void { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
function fail(name: string, err?: any): void { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`) }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

/** Count host-side QEMU processes — covers both arm64 and x86_64 binaries. */
function pgrepQemuCount(): number {
  try {
    const out = execSync(
      'pgrep -fa qemu-system 2>/dev/null || true',
      { encoding: 'utf-8' },
    )
    return out.trim().split('\n').filter(line => line && line.includes('qemu-system')).length
  } catch {
    return 0
  }
}

// -----------------------------------------------------------------------
// Mock /pool/assign server (in-VM agent-runtime won't be ready in the time
// we're willing to wait — and assigning to a real project would require a
// full provisioned workspace). We bypass /pool/assign entirely by stubbing
// the controller's `assign` method below.
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n\x1b[1m=== VM Warm Pool Host Memory Cap E2E (real QEMU) ===\x1b[0m\n')

  // Pre-checks.
  for (const f of ['vmlinuz', 'initrd.img']) {
    if (!fs.existsSync(path.join(VM_IMAGE_DIR, f))) {
      fail('VM kernel/initrd present', `${f} missing from ${VM_IMAGE_DIR}`)
      process.exit(1)
    }
  }
  const hasRootfs =
    fs.existsSync(path.join(VM_IMAGE_DIR, 'rootfs-provisioned.qcow2')) ||
    fs.existsSync(path.join(VM_IMAGE_DIR, 'rootfs.qcow2'))
  if (!hasRootfs) {
    fail('VM rootfs present', `rootfs-provisioned.qcow2 or rootfs.qcow2 missing from ${VM_IMAGE_DIR}`)
    process.exit(1)
  }
  pass('VM images present')

  fs.rmSync(OVERLAY_DIR, { recursive: true, force: true })
  fs.mkdirSync(OVERLAY_DIR, { recursive: true })

  // Kill any leftover QEMUs from earlier runs.
  try { execSync('pkill -f qemu-system 2>/dev/null', { stdio: 'pipe' }) } catch {}
  await sleep(500)
  const baselineQemu = pgrepQemuCount()
  log(`Baseline QEMU count: ${baselineQemu}`)
  if (baselineQemu > 0) {
    fail('No leftover QEMU processes at test start', `${baselineQemu} qemu-system processes already running`)
    process.exit(1)
  }
  pass('No leftover QEMU processes at test start')

  // -----------------------------------------------------------------------
  // Boot the controller.
  // -----------------------------------------------------------------------
  const vmModule = await import('./src/vm/index')
  if (!vmModule.isVMAvailable()) {
    fail('VM availability check', 'isVMAvailable() returned false')
    process.exit(1)
  }
  pass('VM availability check passed')

  const { VMWarmPoolController } = await import('../api/src/lib/vm-warm-pool-controller') as any

  const crypto = await import('crypto')
  const managerFactory: any = () => vmModule.createVMManager()
  const controller = new VMWarmPoolController(
    managerFactory,
    {
      memoryMB: VM_MEMORY_MB,
      cpus: 2,
      networkEnabled: true,
      overlayPath: path.join(OVERLAY_DIR, `pool-${crypto.randomUUID()}.qcow2`),
      vmImageDir: VM_IMAGE_DIR,
    },
    POOL_SIZE,
  )

  // -----------------------------------------------------------------------
  // Bypass /pool/assign — the in-VM agent-runtime needs a real Prisma DB
  // to handle the assign payload. We're testing the controller's cap, not
  // the runtime's assign flow.
  // -----------------------------------------------------------------------
  (controller as any).assign = async function (pod: any, projectId: string) {
    pod.assignedAt = Date.now()
    pod.lastTouchedAt = Date.now()
    pod.projectId = projectId
    ;(this as any).assigned.set(projectId, pod)
    console.log(`[VMWarmPool] [stub-assign] assigned ${pod.vmId} to ${projectId}`)
  }

  let pollMaxQemu = 0
  let polling = true
  ;(async () => {
    while (polling) {
      pollMaxQemu = Math.max(pollMaxQemu, pgrepQemuCount())
      await sleep(250)
    }
  })()

  log('Starting controller...')
  await controller.start()
  log(`Pool started — getStatus(): ${JSON.stringify(controller.getStatus())}`)

  // -----------------------------------------------------------------------
  // The burst.
  // -----------------------------------------------------------------------
  log(`Firing ${PROJECT_COUNT} concurrent getProjectUrl calls (cap is ${MAX_ASSIGNED})...`)
  const t0 = Date.now()
  await Promise.allSettled(
    Array.from({ length: PROJECT_COUNT }, (_, i) =>
      controller.getProjectUrl(`proj-${i}`),
    ),
  )
  log(`Burst complete in ${Date.now() - t0}ms`)
  await sleep(2000)
  polling = false

  // -----------------------------------------------------------------------
  // Assertions.
  // -----------------------------------------------------------------------
  const CAP = POOL_SIZE + MAX_ASSIGNED + 1 // +1 for the cap eviction window
  if (pollMaxQemu > CAP) {
    fail(
      `Live QEMU count stays ≤ poolSize + maxAssigned (${CAP})`,
      `observed ${pollMaxQemu} live QEMU processes — RUNAWAY SPAWN REGRESSION`,
    )
  } else {
    pass(`Live QEMU count stayed ≤ ${CAP} (max: ${pollMaxQemu})`)
  }

  const finalStatus = controller.getStatus()
  if (finalStatus.assigned !== MAX_ASSIGNED) {
    fail('Final assigned count equals cap', `expected ${MAX_ASSIGNED}, got ${finalStatus.assigned}`)
  } else {
    pass(`Final assigned count is exactly ${MAX_ASSIGNED}`)
  }

  // Teardown — every QEMU should disappear after stop().
  log('Stopping controller...')
  await controller.stop()
  await sleep(2000)
  const teardownQemu = pgrepQemuCount()
  if (teardownQemu > 0) {
    fail('All QEMUs cleaned up after controller.stop()', `${teardownQemu} processes still alive`)
  } else {
    pass('All QEMUs cleaned up after controller.stop()')
  }

  fs.rmSync(OVERLAY_DIR, { recursive: true, force: true })

  console.log(`\n\x1b[1mResults: ${passed}/${passed + failed} passed\x1b[0m`)
  if (failed > 0) {
    console.log(`\x1b[31m${failed} test(s) failed — host-memory cap regression\x1b[0m`)
    process.exit(1)
  }
  console.log('\x1b[32mAll tests passed\x1b[0m')
  process.exit(0)
}

main().catch(err => {
  console.error(`\n\x1b[31mFATAL:\x1b[0m ${err?.stack || err?.message || err}`)
  process.exit(1)
})
