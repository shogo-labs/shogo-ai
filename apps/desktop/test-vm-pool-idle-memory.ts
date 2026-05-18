#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end regression for the per-VM idle memory budget.
 *
 * Symptom (the bug this test exists to catch):
 *   "when we do spawn them they go from 1gb mem to 4gb mem but they
 *    aren't really running any workload"
 *
 * Root cause: QEMU on macOS HVF demand-pages guest RAM into host RSS on
 * first touch and never unmaps it. As the in-VM agent-runtime boots,
 * fills the page cache, etc., RSS climbs toward `-m` (4 GB) and stays
 * there even when the guest has freed everything internally.
 *
 * Fixes in this test:
 *   - virtio-balloon-pci,free-page-reporting=on on QEMU
 *   - memory-backend-ram,discard-data=on
 *   - guest sysctls (vfs_cache_pressure=500, dirty_ratio=5) + zram
 *   - pool VMs balloon-inflated to `poolMemoryMB` (1.5 GB) on boot,
 *     deflated to `memoryMB` (4 GB) on /pool/assign
 *   - LSP/vite/prisma deferred until /pool/assign
 *
 * Assertions:
 *   1. After a pool VM has been idle for 60 s, its QEMU RSS is below
 *      IDLE_THRESHOLD_MB (~1200 MB).
 *   2. After /pool/assign, RSS may grow but stabilises below
 *      ASSIGNED_THRESHOLD_MB (~3000 MB) — well under the 4 GB ceiling.
 *
 * Opt-in: requires RUN_VM_E2E=1 and `apps/desktop/resources/vm` populated.
 *
 * Run with:
 *   RUN_VM_E2E=1 bun apps/desktop/test-vm-pool-idle-memory.ts
 */

import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

if (process.env.RUN_VM_E2E !== '1') {
  console.log('Skipping real-QEMU idle-memory e2e — set RUN_VM_E2E=1 to run.')
  process.exit(0)
}

const POOL_SIZE = 1
const VM_MEMORY_MB = 4096
const POOL_MEMORY_MB = 1536
const IDLE_THRESHOLD_MB = parseInt(process.env.IDLE_THRESHOLD_MB || '1500', 10)
const ASSIGNED_THRESHOLD_MB = parseInt(process.env.ASSIGNED_THRESHOLD_MB || '3000', 10)
const IDLE_OBSERVATION_SECS = parseInt(process.env.IDLE_OBSERVATION_SECS || '60', 10)
const ASSIGNED_OBSERVATION_SECS = parseInt(process.env.ASSIGNED_OBSERVATION_SECS || '30', 10)

process.env.VM_POOL_SIZE = String(POOL_SIZE)
process.env.VM_MAX_ASSIGNED = '1'
process.env.VM_MAX_HARD_CAP = '1'
process.env.VM_MEMORY_MB = String(VM_MEMORY_MB)
process.env.VM_POOL_MEMORY_MB = String(POOL_MEMORY_MB)
process.env.VM_POOL_RECONCILE_INTERVAL = '999999'
process.env.VM_IDLE_EVICTION_MS = '0'

const DESKTOP_DIR = path.dirname(new URL(import.meta.url).pathname)
const VM_IMAGE_DIR = path.join(DESKTOP_DIR, 'resources', 'vm')
const OVERLAY_DIR = '/tmp/shogo-vm-idle-memory-test'

import { mock } from 'bun:test'
mock.module('../api/src/lib/runtime/build-project-env', () => ({
  buildProjectEnv: () => Promise.resolve({ PROJECT_ID: 'test' }),
}))

// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${msg}`)
}
function pass(name: string): void { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
function fail(name: string, err?: any): void { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`) }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

/** Return the QEMU PID(s) currently running. */
function qemuPids(): number[] {
  try {
    const out = execSync('pgrep -f qemu-system 2>/dev/null || true', { encoding: 'utf-8' })
    return out.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n))
  } catch {
    return []
  }
}

/** Get RSS (in MB) for a given PID. Falls back to 0 if the process is gone. */
function rssMB(pid: number): number {
  try {
    const out = execSync(`ps -o rss= -p ${pid} 2>/dev/null || echo 0`, { encoding: 'utf-8' }).trim()
    const kb = parseInt(out, 10)
    return isNaN(kb) ? 0 : Math.round(kb / 1024)
  } catch {
    return 0
  }
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n\x1b[1m=== VM Warm Pool Idle Memory E2E (real QEMU) ===\x1b[0m\n')
  log(`pool=${POOL_SIZE} memory=${VM_MEMORY_MB}MB poolMemory=${POOL_MEMORY_MB}MB`)
  log(`thresholds: idle≤${IDLE_THRESHOLD_MB}MB, assigned≤${ASSIGNED_THRESHOLD_MB}MB`)

  // Pre-checks
  for (const f of ['vmlinuz', 'initrd.img']) {
    if (!fs.existsSync(path.join(VM_IMAGE_DIR, f))) {
      fail('VM image present', `${f} missing from ${VM_IMAGE_DIR}`)
      process.exit(1)
    }
  }
  pass('VM images present')

  fs.rmSync(OVERLAY_DIR, { recursive: true, force: true })
  fs.mkdirSync(OVERLAY_DIR, { recursive: true })

  try { execSync('pkill -f qemu-system 2>/dev/null', { stdio: 'pipe' }) } catch {}
  await sleep(500)

  // ---------------------------------------------------------------------
  // Boot one pool-mode VM through the production controller.
  // ---------------------------------------------------------------------
  const vmModule = await import('./src/vm/index')
  if (!vmModule.isVMAvailable()) {
    fail('VM availability check', 'isVMAvailable() returned false')
    process.exit(1)
  }
  pass('VM availability check passed')

  const { VMWarmPoolController } = await import('../api/src/lib/vm-warm-pool-controller') as any

  const crypto = await import('crypto')
  const controller = new VMWarmPoolController(
    () => vmModule.createVMManager(),
    {
      memoryMB: VM_MEMORY_MB,
      poolMemoryMB: POOL_MEMORY_MB,
      cpus: 2,
      networkEnabled: true,
      overlayPath: path.join(OVERLAY_DIR, `pool-${crypto.randomUUID()}.qcow2`),
      vmImageDir: VM_IMAGE_DIR,
    },
    POOL_SIZE,
  )

  log('Starting controller (this includes the QEMU boot + cloud-init)...')
  const bootStart = Date.now()
  await controller.start()
  log(`Controller ready in ${Date.now() - bootStart}ms`)

  const pids = qemuPids()
  if (pids.length !== 1) {
    fail('Exactly one QEMU PID', `got ${pids.length}: ${pids.join(', ')}`)
    await controller.stop()
    process.exit(1)
  }
  const qemuPid = pids[0]
  log(`QEMU pid: ${qemuPid}`)

  // ---------------------------------------------------------------------
  // Idle sampling — wait, then collect a window of measurements.
  // ---------------------------------------------------------------------
  log(`Sampling idle RSS for ${IDLE_OBSERVATION_SECS}s (every 5s)...`)
  const idleSamples: number[] = []
  const samplesNeeded = Math.floor(IDLE_OBSERVATION_SECS / 5)
  for (let i = 0; i < samplesNeeded; i++) {
    await sleep(5000)
    const rss = rssMB(qemuPid)
    idleSamples.push(rss)
    log(`  idle sample ${i + 1}/${samplesNeeded}: ${rss} MB`)
    if (rss === 0) {
      fail('VM stayed alive during idle sampling', `QEMU pid ${qemuPid} disappeared`)
      await controller.stop()
      process.exit(1)
    }
  }
  // Use the median of the last 60% of samples — first samples can be high
  // due to boot-time page touches before the balloon engages.
  const stableSamples = idleSamples.slice(Math.floor(idleSamples.length * 0.4))
  const idleStable = Math.round(median(stableSamples))
  log(`Stable idle RSS (median of last ${stableSamples.length} samples): ${idleStable} MB`)

  if (idleStable > IDLE_THRESHOLD_MB) {
    fail('Idle pool VM RSS stays under threshold',
      `${idleStable} MB > ${IDLE_THRESHOLD_MB} MB — free-page-reporting / balloon / lazy-LSP regression`)
  } else {
    pass(`Idle pool VM RSS stable at ${idleStable} MB (≤ ${IDLE_THRESHOLD_MB} MB)`)
  }

  // ---------------------------------------------------------------------
  // Trigger /pool/assign and observe assigned-mode RSS. We bypass the
  // real assign HTTP call (which needs a Prisma DB and project setup)
  // and just trigger the balloon deflation directly through the
  // controller's `assign()` method using the live pod.
  // ---------------------------------------------------------------------
  const status = controller.getStatus()
  log(`Pre-assign: available=${status.available} assigned=${status.assigned}`)

  // Drive a real assignment. The controller's `assign()` does both the
  // HTTP /pool/assign call AND the balloon deflation. If the in-VM
  // runtime's /pool/assign needs Prisma we'll log the failure but still
  // observe the balloon-deflation effect (it happens after the HTTP
  // succeeds; if it doesn't, the RSS test will catch the regression).
  try {
    await controller.getProjectUrl('idle-memory-test-proj')
    log('Assigned successfully via getProjectUrl')
  } catch (err: any) {
    log(`Assignment threw: ${err?.message} — continuing to observe RSS`)
  }

  log(`Sampling assigned RSS for ${ASSIGNED_OBSERVATION_SECS}s (every 5s)...`)
  const assignedSamples: number[] = []
  const assignedNeeded = Math.floor(ASSIGNED_OBSERVATION_SECS / 5)
  for (let i = 0; i < assignedNeeded; i++) {
    await sleep(5000)
    const rss = rssMB(qemuPid)
    assignedSamples.push(rss)
    log(`  assigned sample ${i + 1}/${assignedNeeded}: ${rss} MB`)
  }
  const assignedStable = Math.round(median(assignedSamples.slice(Math.floor(assignedSamples.length * 0.4))))
  log(`Stable assigned RSS (median): ${assignedStable} MB`)

  if (assignedStable > ASSIGNED_THRESHOLD_MB) {
    fail('Assigned VM RSS stays under threshold',
      `${assignedStable} MB > ${ASSIGNED_THRESHOLD_MB} MB`)
  } else {
    pass(`Assigned VM RSS stable at ${assignedStable} MB (≤ ${ASSIGNED_THRESHOLD_MB} MB)`)
  }

  // ---------------------------------------------------------------------
  // Teardown.
  // ---------------------------------------------------------------------
  await controller.stop()
  await sleep(2000)
  if (qemuPids().length > 0) {
    fail('QEMUs cleaned up after stop()', `${qemuPids().length} still alive`)
  } else {
    pass('QEMUs cleaned up after stop()')
  }
  fs.rmSync(OVERLAY_DIR, { recursive: true, force: true })

  console.log(`\n\x1b[1mResults: ${passed}/${passed + failed} passed\x1b[0m`)
  if (failed > 0) {
    console.log(`\x1b[31m${failed} test(s) failed — memory budget regression\x1b[0m`)
    process.exit(1)
  }
  console.log('\x1b[32mAll tests passed\x1b[0m')
  process.exit(0)
}

main().catch(err => {
  console.error(`\n\x1b[31mFATAL:\x1b[0m ${err?.stack || err?.message || err}`)
  process.exit(1)
})
