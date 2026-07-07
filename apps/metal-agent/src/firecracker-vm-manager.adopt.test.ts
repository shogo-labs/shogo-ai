// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for VM adoption across a node-agent restart. adoptVM() re-attaches
 * to a firecracker process we no longer own a Bun.Subprocess for (it was
 * reparented to init when systemd KillMode=process let the old agent exit), so
 * liveness/kill/count must all work through the pid. We adopt a real child
 * process (a `sleep`) as a stand-in for firecracker and assert:
 *   - isRunning() tracks the real pid (true → kill → false)
 *   - procCount() includes adopted VMs
 *   - reapHostOrphans() never kills a NON-firecracker process (name-scoped)
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { FirecrackerVMManager, type FcVmHandle } from './firecracker-vm-manager'
import { pidAlive } from './live-registry'

const dirs: string[] = []
const procs: { kill: (s?: any) => void }[] = []

function makeMgr() {
  const dir = mkdtempSync(join(tmpdir(), 'fcadopt-'))
  dirs.push(dir)
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
  }
  return new FirecrackerVMManager(cfg as any)
}

function handleFor(pid: number, id = 'adopted-vm'): FcVmHandle {
  return {
    id,
    agentUrl: 'http://172.16.0.2:8080',
    guestIp: '172.16.0.2',
    pid,
    platform: 'linux',
    net: { tap: 'fctap0', guestIp: '172.16.0.2' } as any,
    rootfs: join('/tmp', `${id}.rootfs.ext4`),
    socketPath: join('/tmp', `${id}.sock`),
    serialLog: join('/tmp', `${id}.serial`),
    vcpus: 2,
    memoryMB: 4096,
  }
}

afterEach(async () => {
  for (const p of procs.splice(0)) {
    try {
      p.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('FirecrackerVMManager adoption', () => {
  test('isRunning + procCount track an adopted pid, then go false on kill', async () => {
    const mgr = makeMgr()
    const child = Bun.spawn(['sleep', '30'])
    procs.push(child)

    const handle = handleFor(child.pid)
    mgr.adoptVM(handle)

    expect(mgr.isRunning(handle)).toBe(true)
    expect(mgr.procCount()).toBe(1)

    child.kill('SIGKILL')
    await child.exited
    await Bun.sleep(50)

    expect(pidAlive(child.pid)).toBe(false)
    expect(mgr.isRunning(handle)).toBe(false)
  })

  test('reapHostOrphans never kills a non-firecracker process', async () => {
    const mgr = makeMgr()
    const child = Bun.spawn(['sleep', '30'])
    procs.push(child)

    // Empty keep-set: reaper would kill every firecracker on the host, but our
    // sleep is not firecracker, so it must survive (name-scoped by /proc cmdline).
    const killed = mgr.reapHostOrphans(new Set())
    expect(killed).toBe(0)
    expect(pidAlive(child.pid)).toBe(true)
  })
})
