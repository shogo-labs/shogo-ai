// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Real-VM e2e for per-project machine size (Settings → Machine): boots actual
 * Firecracker microVMs the way an assignment does and reads the size from
 * INSIDE the guest.
 *
 *   1. Standard: no size request → the class size (METAL_VCPUS / METAL_MEM_MIB).
 *   2. Upgrade: the env the API sends for a bigger machine
 *      (SHOGO_VM_BOOT_VCPUS / SHOGO_VM_BOOT_MEM_MIB) → the guest has exactly
 *      those vCPUs and that memory.
 *   3. Downgrade: back to Standard (the API stops sending the keys) → the
 *      guest is back at the class size.
 *   4. A request below the class size never shrinks the VM.
 *
 * The boot size comes from `vmBootSize`, the same function `MetalWarmPool.assign`
 * uses, so the decision and the VMM config are both under test. The guest is a
 * tiny busybox rootfs whose init prints `nproc` and MemTotal to the serial
 * console and powers off (scripts/ci/metal-vm-size-e2e.sh builds it), so it
 * runs on a stock CI runner with /dev/kvm. Needs root (tap devices).
 *
 * Writes e2e-vm-size-results.json to $METAL_WORK and exits non-zero on failure.
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { FirecrackerVMManager, type FcVmHandle } from './firecracker-vm-manager'
import { vmBootSize } from './pool'

const BOOT_TIMEOUT_MS = parseInt(process.env.E2E_BOOT_TIMEOUT_MS ?? '60000', 10)
const UP_VCPUS = parseInt(process.env.E2E_UP_VCPUS ?? '2', 10)
const UP_MEM_MIB = parseInt(process.env.E2E_UP_MEM_MIB ?? '768', 10)
const MARKER = /SHOGO_SIZE nproc=(\d+) memkb=(\d+)/

interface GuestSize {
  vcpus: number
  memKb: number
}

function log(step: string, msg: string) {
  console.log(`[e2e-vm-size] ${step.padEnd(10)} ${msg}`)
}

function fail(msg: string): never {
  throw new Error(msg)
}

/** Wait for the guest init's size line on the serial console. */
async function readGuestSize(h: FcVmHandle): Promise<GuestSize> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    let serial = ''
    try {
      serial = readFileSync(h.serialLog, 'utf8')
    } catch {
      /* not created yet */
    }
    const m = serial.match(MARKER)
    if (m) return { vcpus: Number(m[1]), memKb: Number(m[2]) }
    await Bun.sleep(200)
  }
  let tail = ''
  try {
    tail = readFileSync(h.serialLog, 'utf8').slice(-2000)
  } catch {
    /* ignore */
  }
  fail(`guest ${h.id} never printed its size within ${BOOT_TIMEOUT_MS}ms. Serial tail:\n${tail}`)
}

/** Boot as an assignment with `env` would, read the guest's size, stop it. */
async function bootAs(mgr: FirecrackerVMManager, env: Record<string, string>): Promise<GuestSize & { asked: object }> {
  const size = vmBootSize(env, { vcpus: config.vcpus, memMiB: config.memMiB })
  const h = await mgr.startVM(size ?? {})
  try {
    const guest = await readGuestSize(h)
    return { ...guest, asked: { vcpus: h.vcpus, memoryMB: h.memoryMB } }
  } finally {
    await mgr.stopVM(h)
  }
}

/** The kernel reserves some RAM, so MemTotal sits a little under the VM size. */
function memMatches(memKb: number, memMiB: number): boolean {
  return memKb <= memMiB * 1024 && memKb >= memMiB * 1024 * 0.75
}

async function main() {
  if (UP_VCPUS <= config.vcpus || UP_MEM_MIB <= config.memMiB) {
    fail(
      `upgrade (${UP_VCPUS} vCPU / ${UP_MEM_MIB} MiB) must be bigger than the class ` +
        `(${config.vcpus} vCPU / ${config.memMiB} MiB); set METAL_VCPUS / METAL_MEM_MIB lower`,
    )
  }
  const mgr = new FirecrackerVMManager()
  const report: Record<string, unknown> = {
    class: { vcpus: config.vcpus, memMiB: config.memMiB },
    upgrade: { vcpus: UP_VCPUS, memMiB: UP_MEM_MIB },
    steps: {},
  }
  const steps = report.steps as Record<string, unknown>
  let ok = false

  try {
    const standard = await bootAs(mgr, {})
    steps.standard = standard
    log('standard', JSON.stringify(standard))
    if (standard.vcpus !== config.vcpus || !memMatches(standard.memKb, config.memMiB)) {
      fail(`standard VM should be ${config.vcpus} vCPU / ~${config.memMiB} MiB, guest saw ${JSON.stringify(standard)}`)
    }

    const up = await bootAs(mgr, {
      SHOGO_VM_BOOT_VCPUS: String(UP_VCPUS),
      SHOGO_VM_BOOT_MEM_MIB: String(UP_MEM_MIB),
    })
    steps.upgrade = up
    log('upgrade', JSON.stringify(up))
    if (up.vcpus !== UP_VCPUS || !memMatches(up.memKb, UP_MEM_MIB)) {
      fail(`upgraded VM should be ${UP_VCPUS} vCPU / ~${UP_MEM_MIB} MiB, guest saw ${JSON.stringify(up)}`)
    }
    if (up.memKb <= standard.memKb) fail('upgraded VM has no more memory than the standard one')

    const down = await bootAs(mgr, {})
    steps.downgrade = down
    log('downgrade', JSON.stringify(down))
    if (down.vcpus !== standard.vcpus || Math.abs(down.memKb - standard.memKb) > standard.memKb * 0.02) {
      fail(`after the downgrade the VM should match the standard one ${JSON.stringify(standard)}, guest saw ${JSON.stringify(down)}`)
    }

    const below = await bootAs(mgr, {
      SHOGO_VM_BOOT_VCPUS: '1',
      SHOGO_VM_BOOT_MEM_MIB: String(Math.max(64, Math.floor(config.memMiB / 2))),
    })
    steps.belowClass = below
    log('below', JSON.stringify(below))
    if (below.vcpus !== standard.vcpus || Math.abs(below.memKb - standard.memKb) > standard.memKb * 0.02) {
      fail(`a request below the class must not shrink the VM; guest saw ${JSON.stringify(below)}`)
    }
    ok = true
  } catch (err: any) {
    report.error = err?.message ?? String(err)
    console.error(`[e2e-vm-size] FAIL ${report.error}`)
  } finally {
    report.ok = ok
    const out = join(config.runDir, '..', 'e2e-vm-size-results.json')
    writeFileSync(out, JSON.stringify(report, null, 2))
    log('report', out)
  }
  if (!ok) process.exit(1)
  log('done', 'PASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
