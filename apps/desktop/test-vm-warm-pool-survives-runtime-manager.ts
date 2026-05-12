#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end regression for the warm-pool VM kill race.
 *
 * Production failure observed in the user's main.log:
 *
 *   04:58:52.886 [VMWarmPool] Starting (poolSize: 1, ...)
 *   04:58:53.148 [VMWarmPool] Reconcile: need 1 more VMs
 *   04:58:53.953 [RuntimeManager] Cleaning up 1 stale process(es) on
 *                  ports 37100-37900: 75951
 *   04:58:54.019 [shogo-vm] QEMU exited with code null      ← FIX TARGET
 *   04:58:57.473 [VMWarmPool] COLD START: no warm VM available
 *
 * → the freshly-spawned warm-pool QEMU was SIGKILLed by RuntimeManager
 * because its hostfwd agent port (from `findFreePort(37100)`) sat
 * inside RuntimeManager's stale-process scan range (37100-37900).
 *
 * This script proves the fix:
 *   1. Boot a real warm-pool VM through `DarwinVMManager` (same code
 *      path the production warm pool uses).
 *   2. Wait until QEMU is listening on its hostfwd agent port — the
 *      precise window where the regression used to fire.
 *   3. Construct a fresh `RuntimeManager`, which synchronously runs
 *      `cleanupStaleProcesses()` against ports 37100-37900 and
 *      38100-38900. Before the fix, this killed our VM.
 *   4. Assert that the QEMU PID is still alive afterwards AND that
 *      its hostfwd port is still listening.
 *
 * If you ever see this test SIGKILL its own QEMU at step 3, the fix
 * has regressed.
 *
 * Requires the user-data VM image at
 *   apps/desktop/resources/vm/rootfs-provisioned.qcow2
 * which is the same image production ships.
 *
 * Run with:
 *   bun apps/desktop/test-vm-warm-pool-survives-runtime-manager.ts
 */

import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

const DESKTOP_DIR = path.dirname(new URL(import.meta.url).pathname)
const REPO_ROOT = path.resolve(DESKTOP_DIR, '../..')
const VM_IMAGE_DIR = path.join(DESKTOP_DIR, 'resources', 'vm')
const TEST_OVERLAY_DIR = '/tmp/shogo-vm-warm-pool-test'

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${msg}`)
}
function pass(name: string): void { console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
function fail(name: string, err?: any): void {
  console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`)
}
async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function isPortListening(port: number): boolean {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, { encoding: 'utf-8' }).trim()
    return out.length > 0
  } catch { return false }
}

async function main(): Promise<void> {
  console.log('\n\x1b[1m=== VM Warm-Pool Survives RuntimeManager Init E2E ===\x1b[0m\n')

  // -----------------------------------------------------------------------
  // Pre-checks
  // -----------------------------------------------------------------------
  log('Pre-checks...')

  const vmlinuz = path.join(VM_IMAGE_DIR, 'vmlinuz')
  const initrd = path.join(VM_IMAGE_DIR, 'initrd.img')
  const rootfs = path.join(VM_IMAGE_DIR, 'rootfs-provisioned.qcow2')
  for (const f of [vmlinuz, initrd, rootfs]) {
    if (!fs.existsSync(f)) {
      fail('VM image', `Not found: ${f}`)
      process.exit(1)
    }
  }
  pass('VM images present')

  // QEMU + qemu-img need to exist. Use the same resolver the prod code uses.
  process.env.SHOGO_VM_IMAGE_DIR = VM_IMAGE_DIR
  const vmModule = await import('./src/vm/index')
  if (!vmModule.isVMAvailable()) {
    fail('VM availability', 'isVMAvailable() returned false (missing qemu binary?)')
    process.exit(1)
  }
  pass('VM availability check passed')

  // -----------------------------------------------------------------------
  // Build the warm-pool VMManager exactly the way production does.
  // -----------------------------------------------------------------------
  const mgr = vmModule.createVMManager()
  pass('VMManager instantiated (DarwinVMManager / Win32VMManager)')

  // Prep overlay dir.
  if (fs.existsSync(TEST_OVERLAY_DIR)) fs.rmSync(TEST_OVERLAY_DIR, { recursive: true, force: true })
  fs.mkdirSync(TEST_OVERLAY_DIR, { recursive: true })
  const overlayPath = path.join(TEST_OVERLAY_DIR, 'overlay.qcow2')

  // The pool controller calls ensureOverlay(); the manager exposes it.
  // (Falls back to the manager's internal path resolution otherwise.)
  if (typeof (mgr as any).ensureOverlay === 'function') {
    ;(mgr as any).ensureOverlay(overlayPath)
    pass('Overlay disk created')
  }

  // -----------------------------------------------------------------------
  // Boot the VM. This is the *exact* call the warm pool makes
  // (vm-warm-pool-controller.ts:bootVM → manager.startVM).
  // -----------------------------------------------------------------------
  log('Booting VM (this takes ~15s)...')
  const t0 = Date.now()
  let handle: any
  try {
    handle = await mgr.startVM({
      memoryMB: 2048,
      cpus: 2,
      overlayPath,
      mountWorkspace: false,
    })
  } catch (err: any) {
    fail('VM boot', err.message)
    process.exit(1)
  }
  const bootMs = Date.now() - t0
  pass(`VM booted in ${bootMs}ms (pid=${handle.pid})`)

  let testFailed = false

  try {
    // ---------------------------------------------------------------------
    // Confirm the QEMU PID is registered.
    // ---------------------------------------------------------------------
    const { getRegisteredVMPids } = await import('./src/vm/pid-registry')
    const reg = getRegisteredVMPids()
    if (!reg.has(handle.pid)) {
      fail('Registry contains QEMU PID', `PID ${handle.pid} not in registry`)
      testFailed = true
    } else {
      pass(`QEMU PID ${handle.pid} is registered`)
    }

    // ---------------------------------------------------------------------
    // Confirm QEMU is actually listening on its hostfwd agent port
    // (i.e. it's inside the dangerous 37100-37900 cleanup range).
    // ---------------------------------------------------------------------
    const agentUrl: string = handle.agentUrl
    const agentPort = parseInt(new URL(agentUrl).port, 10)
    if (!Number.isFinite(agentPort) || agentPort <= 0) {
      fail('Agent port resolved', `Got "${agentUrl}"`)
      testFailed = true
    }
    log(`Agent host port: ${agentPort}`)

    if (agentPort < 37100 || agentPort > 37900) {
      fail('Agent port in cleanup range', `Port ${agentPort} is NOT in 37100-37900 — the regression scenario doesn't apply on this run`)
      // Not strictly a test failure, but we wanted to exercise the
      // race. Continue anyway because the registry should still
      // protect any registered PID.
    } else {
      pass(`Agent port ${agentPort} is in the dangerous cleanup range`)
    }

    // Give QEMU a moment to actually bind() the forwarded port.
    for (let i = 0; i < 20; i++) {
      if (isPortListening(agentPort)) break
      await sleep(250)
    }
    if (!isPortListening(agentPort)) {
      fail('QEMU listening on agent port', `Port ${agentPort} not LISTEN`)
      testFailed = true
    } else {
      pass(`QEMU listening on agent port ${agentPort}`)
    }

    // Sanity: lsof on the cleanup range now finds QEMU.
    const lsofOut = execSync(`lsof -nP -iTCP:37100-37900 -sTCP:LISTEN -t 2>/dev/null || true`, { encoding: 'utf-8' }).trim()
    if (!lsofOut.split(/\s+/).includes(String(handle.pid))) {
      fail('lsof sees QEMU PID in cleanup range', `Output was: ${JSON.stringify(lsofOut)}`)
      testFailed = true
    } else {
      pass(`lsof confirms QEMU PID ${handle.pid} listens in cleanup range`)
    }

    // ---------------------------------------------------------------------
    // *** THE REGRESSION TRIGGER ***
    // Construct a fresh RuntimeManager. Its constructor synchronously
    // runs cleanupStaleProcesses() against 37100-37900 + agent offset.
    // Before the fix, this is where the user's QEMU was SIGKILLed.
    // ---------------------------------------------------------------------
    log('Constructing RuntimeManager (this is the regression trigger)...')
    const { RuntimeManager } = await import('../api/src/lib/runtime/manager')
    new RuntimeManager()
    pass('RuntimeManager constructed without throwing')

    // Wait a beat — `kill -9` is async at the kernel level.
    await sleep(750)

    // ---------------------------------------------------------------------
    // VM must still be alive.
    // ---------------------------------------------------------------------
    if (!isPidAlive(handle.pid)) {
      fail('QEMU survives RuntimeManager cleanup', `PID ${handle.pid} no longer alive — REGRESSION`)
      testFailed = true
    } else {
      pass(`QEMU PID ${handle.pid} still alive after RuntimeManager cleanup`)
    }
    if (!isPortListening(agentPort)) {
      fail('QEMU still listening', `Port ${agentPort} no longer LISTEN — REGRESSION`)
      testFailed = true
    } else {
      pass(`QEMU still listening on agent port ${agentPort}`)
    }

    // Construct a SECOND RuntimeManager — production runs cleanup once
    // per RuntimeManager instance. If anything in the constructor was
    // a one-time side effect, this also rules it out.
    new RuntimeManager()
    await sleep(500)
    if (!isPidAlive(handle.pid)) {
      fail('QEMU survives second RuntimeManager init', 'REGRESSION on second pass')
      testFailed = true
    } else {
      pass('QEMU survives a second RuntimeManager init')
    }
  } finally {
    log('Shutting down VM...')
    try { await mgr.stopVM(handle) } catch (err: any) { console.error(`stopVM error: ${err.message}`) }
    try { fs.rmSync(TEST_OVERLAY_DIR, { recursive: true, force: true }) } catch {}
    pass('VM shut down cleanly')
  }

  if (testFailed) {
    console.log('\n\x1b[31m✗ E2E FAILED — warm-pool VM was killed by RuntimeManager (regression)\x1b[0m\n')
    process.exit(1)
  }
  console.log('\n\x1b[32m✓ E2E PASSED — warm-pool VM survived RuntimeManager init\x1b[0m\n')
  process.exit(0)
}

main().catch((err) => {
  console.error(`\n\x1b[31mFATAL:\x1b[0m ${err.stack || err.message || err}`)
  process.exit(1)
})
