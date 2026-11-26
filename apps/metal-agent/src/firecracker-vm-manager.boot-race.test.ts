// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The startup host-scan reaper must never SIGKILL a firecracker process that is
 * still booting (SHO-563).
 *
 * Staging, 2026-11-24: a rootfs activation restarted the agent at 08:47:20. The
 * pool began filling at 08:47:24 (a claim and the reaper tick both trigger a fill
 * and both fire before `start()` resolves), while `adopt()` was still
 * health-probing the 119 adopted VMs. `adopt()` then called
 * `reapHostOrphans(adoptedIds)` — and that set does not contain warm VMs — so the
 * scan killed all 8 processes that had just spawned. The probation watch counted
 * 8/8 failed cold boots and rolled a good image back; the serial logs stop
 * mid-boot with no panic, because the whole VMM was killed.
 *
 * These tests spawn a real child process named `firecracker` (the scan reads
 * /proc/<pid>/cmdline), so they fail on the old code, which killed anything not
 * in `keepIds` at any age.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { FirecrackerVMManager, procAgeMs } from './firecracker-vm-manager'
import { pidAlive } from './live-registry'

/** The reaper and its /proc age source are Linux-only; the rest of the suite is not. */
const linux = test.skipIf(process.platform !== 'linux')

const dirs: string[] = []
const children: Array<{ kill: (s?: any) => void; pid: number }> = []

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeMgr() {
  const dir = mkdtempSync(join(tmpdir(), 'fcrace-'))
  dirs.push(dir)
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
  }
  mkdirSync(cfg.runDir, { recursive: true })
  return { mgr: new FirecrackerVMManager(cfg as any), dir }
}

/**
 * A stand-in firecracker: an executable NAMED `firecracker` that takes the same
 * `--api-sock … --id …` argv and then sits there, like a VMM whose guest is
 * booting.
 *
 * It has to be a real binary, not a shell script: the kernel rewrites a script's
 * argv to `['/bin/bash', '/path/to/firecracker', …]`, so `scanHostFcProcs` —
 * which matches argv[0] — never saw the old (script) stand-in as firecracker and
 * every assertion here passed over an empty scan. A copy of `/bin/sh` keeps
 * argv[0] = this path, `-c 'sleep 300'` blocks like a booting VMM, and the
 * trailing `--id <id>` stays in the argv for the scan to read.
 */
function spawnFakeFc(dir: string, id: string): { kill: (s?: any) => void; pid: number } {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const exe = join(bin, 'firecracker')
  if (!Bun.file(exe).size) {
    copyFileSync('/bin/sh', exe)
    chmodSync(exe, 0o755)
  }
  const child = Bun.spawn([exe, '-c', 'sleep 300', '--api-sock', join(dir, 'run', `${id}.sock`), '--id', id], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  children.push(child)
  return child
}

/** Wait until /proc knows the child's start time (the age is read on every pass). */
async function waitForAge(pid: number): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const age = procAgeMs(pid)
    if (age !== undefined) return age
    await Bun.sleep(10)
  }
  throw new Error(`could not read the age of pid ${pid}`)
}

describe('startup host-scan reaper vs a VM that is still booting', () => {
  linux('a process younger than the grace window survives, even though nothing claims its id', async () => {
    const { mgr, dir } = makeMgr()
    const id = `fcvm-5-${Date.now().toString(36)}`
    const child = spawnFakeFc(dir, id)
    const age = await waitForAge(child.pid)
    expect(age).toBeLessThan(120_000)

    // The scan must actually see it, or every assertion below passes over an
    // empty host and proves nothing — the stand-in was a shell script once and
    // this bit was missing, so the whole file was green for the wrong reason.
    expect(mgr.scanHostFcProcs()).toContainEqual({ pid: child.pid, id })

    // Empty keep-set: exactly the state that killed staging's warm pool — the id
    // is not in the adopted set, because the VM is a fresh warm boot.
    expect(mgr.reapHostOrphans(new Set())).toBe(0)
    expect(pidAlive(child.pid)).toBe(true)
  })

  linux('the grace window is what spares it: with a zero grace the same process is reaped', async () => {
    // Proves the test above is not passing for an unrelated reason (the scan not
    // matching, the pid being unreadable, …).
    const { mgr, dir } = makeMgr()
    const child = spawnFakeFc(dir, `fcvm-6-${Date.now().toString(36)}`)
    await waitForAge(child.pid)

    expect(mgr.reapHostOrphans(new Set(), { graceMs: 0 })).toBe(1)
    await Bun.sleep(50)
    expect(pidAlive(child.pid)).toBe(false)
  })

  linux('a kept id survives at any age, so a warm or in-flight VM is never collateral', async () => {
    const { mgr, dir } = makeMgr()
    const keptId = `fcvm-7-${Date.now().toString(36)}`
    const kept = spawnFakeFc(dir, keptId)
    const stray = spawnFakeFc(dir, `fcvm-8-${Date.now().toString(36)}`)
    await waitForAge(kept.pid)
    await waitForAge(stray.pid)

    expect(mgr.reapHostOrphans(new Set([keptId]), { graceMs: 0 })).toBe(1)
    await Bun.sleep(50)
    expect(pidAlive(kept.pid)).toBe(true)
    expect(pidAlive(stray.pid)).toBe(false)
  })
})
