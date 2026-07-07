// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit test for MetalWarmPool.adopt() — the rolling-deploy path. A fresh pool
 * over the same runDir must re-adopt the microVMs the previous agent left
 * running: for each live-registry entry with an alive pid, an existing API
 * socket, re-attach it to `assigned` (mgr.adoptVM) and keep its handle id out of
 * the host-orphan reap set. Entries whose pid is dead are dropped and NOT
 * adopted. A live proc whose guest fails the (advisory) health probe is still
 * adopted — never reaped — because it holds unsaved user state.
 *
 * We stub the VM manager (adoptVM/reapHostOrphans) and stand up a tiny HTTP
 * server as the "guest" so probeHealth passes. A live pid is provided by a real
 * child process; a dead pid by a killed one.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CacheIndex, type CacheEntry } from './cache-index'
import { config } from './config'
import { LiveRegistry, type LiveVmEntry } from './live-registry'
import { MetalWarmPool } from './pool'

const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'pooladopt-'))
  dirs.push(dir)
  return {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
    snapStore: 'none' as const,
    poolSize: 0, // don't try to boot warm VMs in adopt()'s reconcile
  }
}

function entry(cfg: any, projectId: string, pid: number, agentUrl: string): LiveVmEntry {
  const sock = join(cfg.runDir, `${projectId}.sock`)
  writeFileSync(sock, '') // socket file must exist for adoption
  return {
    projectId,
    vmId: `fcvm-${projectId}`,
    pid,
    guestIp: '127.0.0.1',
    agentUrl,
    socketPath: sock,
    serialLog: join(cfg.runDir, `${projectId}.serial`),
    net: { tap: 'fctap0', guestIp: '127.0.0.1' } as any,
    rootfs: join(cfg.runDir, `${projectId}.rootfs.ext4`),
    vcpus: 2,
    memoryMB: 4096,
    assignedAt: 1000,
    lastTouchedAt: 2000,
    v: 1,
  }
}

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('MetalWarmPool.adopt', () => {
  test('adopts a healthy live VM and reaps everything else; drops dead entries', async () => {
    const cfg = makeCfg()

    // Stand up a "guest" that answers /health so probeHealth passes.
    const guest = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    cleanups.push(() => guest.stop(true))
    const agentUrl = `http://localhost:${guest.port}`

    // A live child = an adoptable VM; a killed child = a dead entry to drop.
    const liveChild = Bun.spawn(['sleep', '30'])
    cleanups.push(() => liveChild.kill('SIGKILL'))
    const deadChild = Bun.spawn(['sleep', '30'])
    deadChild.kill('SIGKILL')
    await deadChild.exited
    await Bun.sleep(50)

    // Seed the registry BEFORE constructing the pool (pool opens the same dir).
    const reg = new LiveRegistry(cfg.runDir)
    reg.put(entry(cfg, 'live-proj', liveChild.pid, agentUrl))
    reg.put(entry(cfg, 'dead-proj', deadChild.pid, agentUrl))

    const adoptedHandles: string[] = []
    let reapKeep: Set<string> | null = null
    const fakeMgr = {
      adoptVM: (h: any) => adoptedHandles.push(h.id),
      reapHostOrphans: (keep: Set<string>) => {
        reapKeep = keep
        return 3
      },
      procCount: () => 0,
    }

    const pool = new MetalWarmPool(fakeMgr as any, cfg as any)
    const res = await pool.adopt()

    // Only the live, healthy VM is adopted.
    expect(res.adopted).toEqual(['live-proj'])
    expect(res.reaped).toBe(3)
    expect(adoptedHandles).toEqual(['fcvm-live-proj'])
    expect(pool.getAssigned('live-proj')?.handle.pid).toBe(liveChild.pid)
    expect(pool.getAssigned('dead-proj')).toBeUndefined()

    // The reap set keeps exactly the adopted handle id (so the reaper spares it).
    expect(reapKeep && [...reapKeep]).toEqual(['fcvm-live-proj'])

    // The dead entry is pruned from the durable registry.
    expect(reg.get('dead-proj')).toBeNull()
    expect(reg.get('live-proj')?.pid).toBe(liveChild.pid)
  })

  test('adopts a live proc whose guest is unhealthy (never reaps a running VM)', async () => {
    const cfg = makeCfg()

    // A live child, but point the agentUrl at a closed port so probeHealth fails.
    const liveChild = Bun.spawn(['sleep', '30'])
    cleanups.push(() => liveChild.kill('SIGKILL'))
    const deadUrl = 'http://127.0.0.1:1' // nothing listening → health probe fails

    const reg = new LiveRegistry(cfg.runDir)
    reg.put(entry(cfg, 'wedged-proj', liveChild.pid, deadUrl))

    const adoptedHandles: string[] = []
    let reapKeep: Set<string> | null = null
    const fakeMgr = {
      adoptVM: (h: any) => adoptedHandles.push(h.id),
      reapHostOrphans: (keep: Set<string>) => {
        reapKeep = keep
        return 0
      },
      procCount: () => 0,
    }

    const pool = new MetalWarmPool(fakeMgr as any, cfg as any)
    const res = await pool.adopt()

    // The live-but-unhealthy VM is adopted (kept), NOT dropped/reaped.
    expect(res.adopted).toEqual(['wedged-proj'])
    expect(adoptedHandles).toEqual(['fcvm-wedged-proj'])
    expect(reapKeep && [...reapKeep]).toEqual(['fcvm-wedged-proj'])
    // Its registry entry survives so a subsequent restart re-adopts it too.
    expect(reg.get('wedged-proj')?.pid).toBe(liveChild.pid)
  })

  // Regression: VM_SEQ used to be a module global reset to 0 on every restart,
  // so after a rolling deploy the warm-pool spawner reused a `fctap<n>` index
  // still held by an adopted (live) or suspended (resume-on-demand) VM. setupTap
  // deletes-then-recreates that device, corrupting the live VM's tap fd
  // ("Failed to write to tap: File descriptor in bad state") and blackholing its
  // preview. The pool must now seed the FC manager's index PAST every persisted
  // tap so a fresh warm VM can never collide.
  test('seedVmIndexAllocator advances the FC index past adopted + suspended taps', () => {
    const cfg = makeCfg()

    // A live (adopted) VM on fctap7 and a suspended (cache) VM on fctap9.
    const reg = new LiveRegistry(cfg.runDir)
    reg.put({
      ...entry(cfg, 'live-proj', 111, 'http://127.0.0.1:1'),
      net: { tap: 'fctap7', guestIp: '127.0.0.1' } as any,
    })
    const idx = new CacheIndex(cfg.snapDir)
    idx.put({
      projectId: 'susp-proj',
      vmId: 'fcvm-susp',
      snapshotPath: '',
      memFilePath: '',
      rootfs: '',
      net: { tap: 'fctap9', guestIp: '172.16.0.38' } as any,
      vcpus: 2,
      memoryMB: 4096,
      bytesMem: 0,
      bytesState: 0,
      bytesRootfs: 0,
      createdAt: 1,
      suspendedAt: 1,
      lastAccessAt: 1,
      rootfsIdentity: 'x',
      v: 1,
    } as CacheEntry)

    let seeded = -1
    const fakeMgr = { seedVmSeq: (n: number) => { seeded = n } }
    const pool = new MetalWarmPool(fakeMgr as any, cfg as any)

    // Exercise the seeding step directly (start() would also run adopt/reconcile).
    ;(pool as any).seedVmIndexAllocator()

    // max(7, 9) + 1 — the next warm VM lands on fctap10, clear of both.
    expect(seeded).toBe(10)
  })
})
