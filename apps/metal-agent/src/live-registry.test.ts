// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the durable live-VM registry + pid liveness — the state that
 * lets a fresh node-agent re-adopt firecracker microVMs that survived a rolling
 * deploy (systemd KillMode=process). We assert round-trip persistence across a
 * "restart" (a second LiveRegistry over the same dir) and that pidAlive tracks
 * real process liveness.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LiveRegistry, pidAlive, type LiveVmEntry } from './live-registry'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-'))
  dirs.push(dir)
  return dir
}

function entry(projectId: string, pid: number): LiveVmEntry {
  return {
    projectId,
    vmId: `fcvm-${projectId}`,
    pid,
    guestIp: '172.16.0.2',
    agentUrl: 'http://172.16.0.2:8080',
    socketPath: `/run/${projectId}.sock`,
    serialLog: `/run/${projectId}.serial`,
    net: { tap: 'fctap0', guestIp: '172.16.0.2', hostIp: '172.16.0.1', guestMac: 'AA:BB', bootIpArg: 'ip=…' } as any,
    rootfs: `/run/${projectId}.rootfs.ext4`,
    vcpus: 2,
    memoryMB: 4096,
    assignedAt: 1000,
    lastTouchedAt: 2000,
    v: 1,
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('LiveRegistry', () => {
  test('put/get/all round-trips and survives a fresh instance (restart)', () => {
    const dir = makeDir()
    const reg = new LiveRegistry(dir)
    reg.put(entry('proj-a', 111))
    reg.put(entry('proj-b', 222))

    expect(reg.get('proj-a')?.pid).toBe(111)
    expect(reg.all().length).toBe(2)

    // A brand-new registry over the same runDir simulates a node-agent restart.
    const reg2 = new LiveRegistry(dir)
    const all = reg2.all().sort((a, b) => a.projectId.localeCompare(b.projectId))
    expect(all.map((e) => e.projectId)).toEqual(['proj-a', 'proj-b'])
    expect(all[0].vmId).toBe('fcvm-proj-a')
    expect(all[1].pid).toBe(222)
  })

  test('remove deletes only the targeted entry', () => {
    const dir = makeDir()
    const reg = new LiveRegistry(dir)
    reg.put(entry('proj-a', 111))
    reg.put(entry('proj-b', 222))
    reg.remove('proj-a')
    expect(reg.get('proj-a')).toBeNull()
    expect(reg.all().map((e) => e.projectId)).toEqual(['proj-b'])
  })

  test('handles projectIds with unsafe filename characters', () => {
    const dir = makeDir()
    const reg = new LiveRegistry(dir)
    const id = 'org/proj:weird id'
    reg.put(entry(id, 333))
    expect(reg.get(id)?.pid).toBe(333)
    expect(new LiveRegistry(dir).get(id)?.pid).toBe(333)
  })
})

describe('pidAlive', () => {
  test('true for this process, false for a reaped pid', async () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)

    // Spawn a real child, confirm alive, kill it, confirm dead.
    const proc = Bun.spawn(['sleep', '30'])
    expect(pidAlive(proc.pid)).toBe(true)
    proc.kill('SIGKILL')
    await proc.exited
    // Give the kernel a beat to fully reap.
    await Bun.sleep(50)
    expect(pidAlive(proc.pid)).toBe(false)
  })
})
