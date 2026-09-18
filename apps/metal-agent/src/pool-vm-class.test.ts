// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * VM classes (Phase 1 of the Tier 2 docker project class plan).
 *
 * Exercises the pool's class-aware warm-pool fill, claim, and cold-boot-assign
 * behavior with a fake FirecrackerVMManager (no real Firecracker host) plus a
 * tiny local HTTP "guest" so health probes and /pool/assign succeed. A
 * standard-only host (no METAL_DOCKER_ROOTFS) must behave EXACTLY as before —
 * that's the regression this class of change is riskiest for.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmConfig, FcVmHandle } from './firecracker-vm-manager'
import { MetalWarmPool } from './pool'
import type { SnapshotStore } from './snapshot-store'

const dirs: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A local "guest" that answers /health and /pool/assign for every fake VM. */
function makeGuest() {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  cleanups.push(() => server.stop(true))
  return server
}

/** Fake manager: startVM hands back a handle whose vmClass is whatever was requested. */
function fakeMgr(guestPort: number) {
  let n = 0
  const started: FcVmConfig[] = []
  const stopped: FcVmHandle[] = []
  return {
    started,
    stopped,
    async startVM(cfg: FcVmConfig = {}): Promise<FcVmHandle> {
      n++
      const vmClass = cfg.vmClass ?? 'standard'
      started.push(cfg)
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
        vmClass,
      }
    },
    async stopVM(handle: FcVmHandle): Promise<void> {
      stopped.push(handle)
    },
    isRunning: () => true,
    procCount: () => 0,
    reapHostOrphans: () => 0,
  }
}

function makeCfg(overrides: Partial<MetalConfig> = {}): MetalConfig {
  const dir = mkdtempSync(join(tmpdir(), 'poolvmclass-'))
  dirs.push(dir)
  const snapDir = join(dir, 'snap')
  const runDir = join(dir, 'run')
  mkdirSync(snapDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  return { ...config, work: dir, snapDir, runDir, poolSize: 0, snapStore: 'none', ...overrides } as MetalConfig
}

describe('VM classes — warm pool fill', () => {
  test('a standard-only host (no docker rootfs configured) only ever fills the standard pool', async () => {
    const guest = makeGuest()
    const cfg = makeCfg({ poolSize: 2 })
    const mgr = fakeMgr(guest.port)
    const pool = new MetalWarmPool(mgr as any, cfg, { kind: 'none' } as unknown as SnapshotStore)

    await pool.start()

    expect(mgr.started.length).toBe(2)
    for (const cfgArg of mgr.started) expect(cfgArg.vmClass).toBe('standard')
    const status = pool.status()
    expect(status.available).toBe(2)
    expect(status.classes.find((c) => c.vmClass === 'docker')?.supported).toBe(false)
    expect(status.classes.find((c) => c.vmClass === 'docker')?.available).toBe(0)
  })

  test('a docker-capable host fills BOTH pools to their own independent targets', async () => {
    const guest = makeGuest()
    const cfg = makeCfg({
      poolSize: 1,
      dockerClass: { ...config.dockerClass, baseRootfs: '/opt/docker-rootfs.ext4', poolSize: 2 },
    })
    const mgr = fakeMgr(guest.port)
    const pool = new MetalWarmPool(mgr as any, cfg, { kind: 'none' } as unknown as SnapshotStore)

    await pool.start()

    const byClass = (c: 'standard' | 'docker') => mgr.started.filter((s) => (s.vmClass ?? 'standard') === c)
    expect(byClass('standard').length).toBe(1)
    expect(byClass('docker').length).toBe(2)

    const status = pool.status()
    expect(status.available).toBe(3)
    expect(status.classes.find((c) => c.vmClass === 'docker')).toMatchObject({
      supported: true,
      poolSize: 2,
      available: 2,
    })
    expect(status.classes.find((c) => c.vmClass === 'standard')).toMatchObject({
      supported: true,
      poolSize: 1,
      available: 1,
    })
  })
})

describe('VM classes — claim / assign routing', () => {
  test('assign() with SHOGO_RUNTIME_CLASS=docker claims a docker-pool VM, not a standard one', async () => {
    const guest = makeGuest()
    const cfg = makeCfg({
      poolSize: 1,
      dockerClass: { ...config.dockerClass, baseRootfs: '/opt/docker-rootfs.ext4', poolSize: 1 },
    })
    const mgr = fakeMgr(guest.port)
    const pool = new MetalWarmPool(mgr as any, cfg, { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()

    const a = await pool.assign('proj-docker', { SHOGO_RUNTIME_CLASS: 'docker' })
    expect(a.handle.vmClass).toBe('docker')

    const b = await pool.assign('proj-standard', {})
    expect(b.handle.vmClass).toBe('standard')
  })

  test('a docker-class request falls back to standard on a host that does not support it (fail closed, not silent)', async () => {
    const guest = makeGuest()
    const cfg = makeCfg({ poolSize: 1 }) // no dockerClass.baseRootfs configured
    const mgr = fakeMgr(guest.port)
    const pool = new MetalWarmPool(mgr as any, cfg, { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()

    const errors: any[] = []
    const origError = console.error
    console.error = (...args: any[]) => errors.push(args)
    try {
      const a = await pool.assign('proj-x', { SHOGO_RUNTIME_CLASS: 'docker' })
      expect(a.handle.vmClass).toBe('standard')
    } finally {
      console.error = origError
    }
    expect(errors.some((e) => String(e[0]).includes('does not support it'))).toBe(true)
  })

  test('a cold-boot miss (no warm docker VM available) still boots the right class directly', async () => {
    const guest = makeGuest()
    const cfg = makeCfg({
      poolSize: 0,
      dockerClass: { ...config.dockerClass, baseRootfs: '/opt/docker-rootfs.ext4', poolSize: 0 },
    })
    const mgr = fakeMgr(guest.port)
    const pool = new MetalWarmPool(mgr as any, cfg, { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()

    const a = await pool.assign('proj-cold-docker', { SHOGO_RUNTIME_CLASS: 'docker' })
    expect(a.handle.vmClass).toBe('docker')
    expect(mgr.started.at(-1)?.vmClass).toBe('docker')
  })
})

describe('VM classes — per-class rootfs identity (suspend/resume freshness)', () => {
  test('a docker-class snapshot is stamped and validated against the DOCKER identity, not the standard one', async () => {
    const guest = makeGuest()
    const cfg = makeCfg({ poolSize: 0 })
    // computeRootfsIdentity stats the real file (size+mtime) — give standard
    // and docker genuinely different golden images so their identities differ.
    const standardRootfsPath = join(cfg.work, 'standard-rootfs.ext4')
    writeFileSync(standardRootfsPath, Buffer.alloc(1024))
    ;(cfg as any).baseRootfs = standardRootfsPath
    const dockerRootfsPath = join(cfg.work, 'docker-rootfs.ext4')
    writeFileSync(dockerRootfsPath, Buffer.alloc(4096))
    ;(cfg as any).dockerClass = { ...config.dockerClass, baseRootfs: dockerRootfsPath, poolSize: 0 }
    const mgr = fakeMgr(guest.port) as any
    // snapshotVM is exercised elsewhere against a real FC socket; here we only
    // need it to hand back a well-shaped FcSnapshot carrying the VM's class.
    mgr.snapshotVM = async (handle: FcVmHandle) => ({
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
    })
    mgr.durableRootfs = () => ({ path: '/tmp/x.rootfs', mode: 'full' })
    mgr.restoreRootfsArtifactPath = (p: string) => p

    const pool = new MetalWarmPool(mgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()

    const a = await pool.assign('proj-docker', { SHOGO_RUNTIME_CLASS: 'docker' })
    expect(a.handle.vmClass).toBe('docker')

    const s = await pool.suspend('proj-docker')
    expect(s.snapshot.vmClass).toBe('docker')
    // The stamped identity must be the DOCKER class's identity, and — because
    // the two golden images are different files — must differ from standard's.
    const standardId = (pool as any).classRootfsIdentity('standard')
    const dockerId = (pool as any).classRootfsIdentity('docker')
    expect(s.rootfsIdentity).toBe(dockerId)
    expect(dockerId).not.toBe(standardId)

    // A same-class re-check must NOT consider it stale.
    expect((pool as any).localSnapshotIsStale(s)).toBe(false)
  })
})
