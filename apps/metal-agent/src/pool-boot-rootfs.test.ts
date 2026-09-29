// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Boot-rootfs identity: a VM records the golden rootfs its guest booted from,
 * and its snapshot is stamped with THAT identity rather than the host's
 * current one. Without this, a VM adopted across a rootfs rebuild suspended
 * with the new identity and kept resuming the old guest code indefinitely.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmConfig, FcVmHandle } from './firecracker-vm-manager'
import { LiveRegistry, type LiveVmEntry } from './live-registry'
import { MetalWarmPool } from './pool'
import type { SnapshotStore } from './snapshot-store'

const dirs: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeGuest() {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  cleanups.push(() => server.stop(true))
  return server
}

function fakeMgr(guestPort: number) {
  let n = 0
  return {
    async startVM(cfg: FcVmConfig = {}): Promise<FcVmHandle> {
      n++
      return {
        id: `vm-${n}`,
        agentUrl: `http://127.0.0.1:${guestPort}`,
        guestIp: '127.0.0.1',
        pid: 1000 + n,
        platform: 'linux',
        net: { tap: `fctap${n}`, guestIp: '127.0.0.1' } as any,
        rootfs: `/tmp/fake-rootfs-${n}`,
        socketPath: `/tmp/fake-${n}.sock`,
        serialLog: `/tmp/fake-${n}.serial`,
        vcpus: cfg.cpus ?? 2,
        memoryMB: cfg.memoryMB ?? 1024,
        vmClass: cfg.vmClass ?? 'standard',
      }
    },
    async stopVM(): Promise<void> {},
    isRunning: () => true,
    procCount: () => 0,
    reapHostOrphans: () => 0,
    adoptVM: () => {},
    async snapshotVM(handle: FcVmHandle) {
      return {
        vmId: handle.id,
        snapshotPath: '/tmp/x.vmstate',
        memFilePath: '/tmp/x.mem',
        net: handle.net,
        rootfs: handle.rootfs,
        vcpus: handle.vcpus,
        memoryMB: handle.memoryMB,
        createdAt: Date.now(),
        bytesMem: 0,
        bytesState: 0,
        bytesRootfs: 0,
        vmClass: handle.vmClass,
      }
    },
    durableRootfs: () => ({ path: '/tmp/x.rootfs', mode: 'full' }),
    restoreRootfsArtifactPath: (p: string) => p,
  }
}

function makeCfg(): MetalConfig {
  const dir = mkdtempSync(join(tmpdir(), 'poolbootrootfs-'))
  dirs.push(dir)
  const snapDir = join(dir, 'snap')
  const runDir = join(dir, 'run')
  mkdirSync(snapDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  const baseRootfs = join(dir, 'rootfs.ext4')
  writeFileSync(baseRootfs, Buffer.alloc(1024))
  return { ...config, work: dir, snapDir, runDir, baseRootfs, poolSize: 0, snapStore: 'none' } as MetalConfig
}

/** A durable store that records pushes; `head` reports no existing snapshot. */
function recordingStore() {
  const pushes: any[] = []
  const store = {
    kind: 's3',
    head: async () => null,
    push: async (_files: unknown, meta: unknown) => { pushes.push(meta) },
    pull: async () => null,
  } as unknown as SnapshotStore
  return { store, pushes }
}

describe('boot rootfs identity', () => {
  test('a claimed VM records the current identity and reports rootfsFresh', async () => {
    const guest = makeGuest()
    const cfg = makeCfg()
    const pool = new MetalWarmPool(fakeMgr(guest.port) as any, cfg, { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()

    const a = await pool.assign('ws:proj:p1', {})
    const current = (pool as any).classRootfsIdentity('standard')
    expect(a.bootRootfsIdentity).toBe(current)

    const status = pool.getProjectStatus('ws:proj:p1')
    expect(status.state).toBe('assigned')
    expect(status.rootfsFresh).toBe(true)
    expect(status.activeStreams).toBe(0)
    expect(typeof status.realIdleMs).toBe('number')
    expect(status.lastRealActivityAt).toBe(a.lastRealActivityAt)
  })

  test('a VM from a superseded rootfs is reported stale and its snapshot stamped stale', async () => {
    const guest = makeGuest()
    const cfg = makeCfg()
    const { store, pushes } = recordingStore()
    const pool = new MetalWarmPool(fakeMgr(guest.port) as any, cfg, store)
    await pool.start()

    const a = await pool.assign('ws:proj:p1', {})
    a.bootRootfsIdentity = 'OLD-IMAGE' // as if adopted across a rebuild
    expect(pool.getProjectStatus('ws:proj:p1').rootfsFresh).toBe(false)

    const s = await pool.suspend('ws:proj:p1')
    expect(s.rootfsIdentity).toBe('OLD-IMAGE')
    expect((pool as any).localSnapshotIsStale(s)).toBe(true)
    // Every pull would reject it, so it is never uploaded.
    expect(pushes).toEqual([])

    const suspended = pool.getProjectStatus('ws:proj:p1')
    expect(suspended.state).toBe('suspended')
    expect(suspended.rootfsFresh).toBe(false)
  })

  test('a fresh VM suspends with the current identity and pushes it durably', async () => {
    const guest = makeGuest()
    const cfg = makeCfg()
    const { store, pushes } = recordingStore()
    const pool = new MetalWarmPool(fakeMgr(guest.port) as any, cfg, store)
    await pool.start()

    await pool.assign('ws:proj:p1', {})
    const current = (pool as any).classRootfsIdentity('standard')
    const s = await pool.suspend('ws:proj:p1')
    expect(s.rootfsIdentity).toBe(current)
    expect(pushes.length).toBe(1)
    expect(pushes[0].rootfsIdentity).toBe(current)
    expect(pushes[0].baseIdentity).toBe(current)
    expect(pool.getProjectStatus('ws:proj:p1').rootfsFresh).toBe(true)
  })

  test('the identity is persisted to the live registry and restored on adopt', async () => {
    const guest = makeGuest()
    const cfg = makeCfg()
    const pool = new MetalWarmPool(fakeMgr(guest.port) as any, cfg, { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()
    const a = await pool.assign('ws:proj:p1', {})
    expect(new LiveRegistry(cfg.runDir).all().find((e) => e.projectId === 'ws:proj:p1')?.bootRootfsIdentity)
      .toBe(a.bootRootfsIdentity)

    // A fresh agent over the same runDir adopts a live VM from before a rebuild.
    const live = Bun.spawn(['sleep', '30'])
    cleanups.push(() => live.kill('SIGKILL'))
    const sock = join(cfg.runDir, 'adopted.sock')
    writeFileSync(sock, '')
    const entry: LiveVmEntry = {
      projectId: 'ws:proj:adopted',
      vmId: 'fcvm-adopted',
      pid: live.pid,
      guestIp: '127.0.0.1',
      agentUrl: `http://127.0.0.1:${guest.port}`,
      socketPath: sock,
      serialLog: join(cfg.runDir, 'adopted.serial'),
      net: { tap: 'fctap9', guestIp: '127.0.0.1' } as any,
      rootfs: join(cfg.runDir, 'adopted.rootfs.ext4'),
      vcpus: 2,
      memoryMB: 1024,
      assignedAt: 1000,
      lastTouchedAt: 2000,
      bootRootfsIdentity: 'OLD-IMAGE',
      v: 1,
    }
    const reg = new LiveRegistry(cfg.runDir)
    reg.remove('ws:proj:p1')
    reg.put(entry)

    const next = new MetalWarmPool(fakeMgr(guest.port) as any, cfg, { kind: 'none' } as unknown as SnapshotStore)
    await next.adopt()
    expect(next.getAssigned('ws:proj:adopted')?.bootRootfsIdentity).toBe('OLD-IMAGE')
    expect(next.getProjectStatus('ws:proj:adopted').rootfsFresh).toBe(false)
  })
})
