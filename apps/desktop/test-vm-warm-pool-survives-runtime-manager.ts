#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end regression for the warm-pool VM kill race.
 *
 * Production failure observed in the user's 1.6.x main.log:
 *
 *   04:58:52.886 [VMWarmPool] Starting (poolSize: 1, ...)
 *   04:58:53.148 [VMWarmPool] Reconcile: need 1 more VMs
 *   04:58:53.953 [RuntimeManager] Cleaning up 1 stale process(es) on
 *                  ports 37100-37900: 75951
 *   04:58:54.019 [shogo-vm] QEMU exited with code null      ← BUG
 *   04:58:57.473 [VMWarmPool] COLD START: no warm VM available
 *
 * Root cause: `findFreePort(37100)` / `findFreePort(38100)` allocated
 * the VM's hostfwd ports inside `RuntimeManager.cleanupStaleProcesses`
 * scan range (37100-37900 + agent offset 38100-38900). When
 * RuntimeManager initialised ~1s after the warm pool spawned its first
 * QEMU, its `lsof | kill -9` pass treated the brand-new VM as a
 * leftover process and SIGKILLed it.
 *
 * Fix: move the VM hostfwd bases to 39200 (agent) / 39400 (skill) —
 * above the API port (39100), the legacy RUNTIME_BASE_PORT (39110),
 * and well outside the RuntimeManager scan range. See
 * `darwin-vm-manager.ts` / `win32-vm-manager.ts`.
 *
 * This script asserts the fix end-to-end:
 *   1. Boot a real warm-pool VM through the production `DarwinVMManager`
 *      (or `Win32VMManager` on Windows).
 *   2. Read the allocated agent host port from the VM handle.
 *   3. Assert it sits OUTSIDE 37100-37900 (the dangerous range).
 *   4. Construct a fresh `RuntimeManager`, which synchronously runs
 *      its stale-process cleanup against the dangerous range.
 *   5. Assert the QEMU PID is still alive and still listening
 *      afterwards. (Pre-fix, step 4 reliably SIGKILLed QEMU here.)
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
const VM_IMAGE_DIR = path.join(DESKTOP_DIR, 'resources', 'vm')
const TEST_OVERLAY_DIR = '/tmp/shogo-vm-warm-pool-test'

// Must match `apps/api/src/lib/runtime/manager.ts` PORT_RANGE_START..END
// and PORT_RANGE_START + AGENT_PORT_OFFSET..END + AGENT_PORT_OFFSET.
const RUNTIME_VITE_RANGE = { start: 37100, end: 37900 } as const
const RUNTIME_AGENT_RANGE = { start: 38100, end: 38900 } as const

function inRange(port: number, range: { start: number; end: number }): boolean {
  return port >= range.start && port <= range.end
}

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

  if (fs.existsSync(TEST_OVERLAY_DIR)) fs.rmSync(TEST_OVERLAY_DIR, { recursive: true, force: true })
  fs.mkdirSync(TEST_OVERLAY_DIR, { recursive: true })
  const overlayPath = path.join(TEST_OVERLAY_DIR, 'overlay.qcow2')

  if (typeof (mgr as any).ensureOverlay === 'function') {
    ;(mgr as any).ensureOverlay(overlayPath)
    pass('Overlay disk created')
  }

  // -----------------------------------------------------------------------
  // Boot the VM. This is the *exact* call the warm pool makes
  // (vm-warm-pool-controller.ts:bootVM → manager.startVM).
  // -----------------------------------------------------------------------
  log('Booting VM (this takes ~1-15s depending on first-boot caching)...')
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
    // *** THE FIX ASSERTION ***
    // Agent + skill host ports MUST be outside RuntimeManager's
    // stale-process scan range. This is the structural guarantee
    // that makes the SIGKILL race impossible — not a runtime filter,
    // not a registry, just disjoint port ranges.
    // ---------------------------------------------------------------------
    const agentUrl: string = handle.agentUrl
    const agentPort = parseInt(new URL(agentUrl).port, 10)
    log(`Agent host port: ${agentPort}`)

    if (!Number.isFinite(agentPort) || agentPort <= 0) {
      fail('Agent port resolved', `Got "${agentUrl}"`)
      testFailed = true
    }

    if (inRange(agentPort, RUNTIME_VITE_RANGE)) {
      fail(
        'Agent port outside RuntimeManager vite scan range',
        `Port ${agentPort} is INSIDE ${RUNTIME_VITE_RANGE.start}-${RUNTIME_VITE_RANGE.end} — REGRESSION`,
      )
      testFailed = true
    } else {
      pass(`Agent port ${agentPort} is outside ${RUNTIME_VITE_RANGE.start}-${RUNTIME_VITE_RANGE.end}`)
    }

    if (inRange(agentPort, RUNTIME_AGENT_RANGE)) {
      fail(
        'Agent port outside RuntimeManager agent scan range',
        `Port ${agentPort} is INSIDE ${RUNTIME_AGENT_RANGE.start}-${RUNTIME_AGENT_RANGE.end} — REGRESSION`,
      )
      testFailed = true
    } else {
      pass(`Agent port ${agentPort} is outside ${RUNTIME_AGENT_RANGE.start}-${RUNTIME_AGENT_RANGE.end}`)
    }

    // The skill server port lives on the handle's `skillServerPort`
    // when DarwinVMManager populates it. Check it the same way.
    const skillPort: number | undefined = (handle as any).skillServerPort
    if (typeof skillPort === 'number') {
      log(`Skill server host port: ${skillPort}`)
      if (inRange(skillPort, RUNTIME_VITE_RANGE) || inRange(skillPort, RUNTIME_AGENT_RANGE)) {
        fail('Skill port outside RuntimeManager scan ranges', `Port ${skillPort} is INSIDE — REGRESSION`)
        testFailed = true
      } else {
        pass(`Skill port ${skillPort} is outside RuntimeManager scan ranges`)
      }
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

    // ---------------------------------------------------------------------
    // *** THE REGRESSION TRIGGER ***
    // Construct a fresh RuntimeManager. Its constructor synchronously
    // runs cleanupStaleProcesses() against 37100-37900 + 38100-38900.
    // Pre-fix, this was where the user's QEMU was SIGKILLed because
    // its agent port was 37100 — exactly inside the scan range.
    // ---------------------------------------------------------------------
    log('Constructing RuntimeManager (the regression trigger)...')
    const { RuntimeManager } = await import('../api/src/lib/runtime/manager')
    new RuntimeManager()
    pass('RuntimeManager constructed without throwing')

    // `kill -9` is async at the kernel level — give it a moment.
    await sleep(750)

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

    // A SECOND RuntimeManager — rules out one-time-only behaviours.
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
    console.log('\n\x1b[31m✗ E2E FAILED — VM hostfwd port collides with RuntimeManager (regression)\x1b[0m\n')
    process.exit(1)
  }
  console.log('\n\x1b[32m✓ E2E PASSED — VM ports are outside RuntimeManager\'s scan range, QEMU survives init\x1b[0m\n')
  process.exit(0)
}

main().catch((err) => {
  console.error(`\n\x1b[31mFATAL:\x1b[0m ${err.stack || err.message || err}`)
  process.exit(1)
})
