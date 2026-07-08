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
import { FirecrackerVMManager } from './firecracker-vm-manager'
import { LiveRegistry, type LiveVmEntry } from './live-registry'
import { deriveNet } from './net'
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

/** A suspended (resume-on-demand) cache entry pinned to a specific tap device. */
function suspEntry(projectId: string, tap: string): CacheEntry {
  return {
    projectId,
    vmId: `fcvm-${projectId}`,
    snapshotPath: '',
    memFilePath: '',
    rootfs: '',
    net: { tap, guestIp: '172.16.0.38' } as any,
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
  } as CacheEntry
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

  // ---------------------------------------------------------------------------
  // Regression: the adopt-on-restart tap-fd corruption bug.
  //
  // The warm-VM/tap index was a MODULE-GLOBAL `VM_SEQ` reset to 0 on every
  // node-agent start. After a rolling deploy the agent adopts the microVMs that
  // survived (keeping their `fctap<n>` devices), but the spawner then handed out
  // fctap0, fctap1, … again. `setupTap` deletes-then-recreates the device, so a
  // fresh warm VM reusing a survivor's (or a suspended project's) index tore the
  // tap fd out from under the still-running Firecracker — serial log "Failed to
  // write to tap: File descriptor in bad state", preview blackholed until a full
  // restart cycled the VM. The fix makes the index an INSTANCE field seeded at
  // startup past every persisted (adopted + suspended) tap.
  // ---------------------------------------------------------------------------
  describe('adopt-on-restart tap-index collision safety', () => {
    // The manager's own contract: seeding raises the next index and never lets
    // it go backwards (monotonic → an index is never reused within a lifetime).
    test('seedVmSeq raises the next tap index monotonically', () => {
      const cfg = makeCfg()
      const mgr = new FirecrackerVMManager(cfg as any)

      // A fresh manager starts at fctap0 — this is exactly the reset-to-0 that
      // the old module-global exhibited on every restart.
      expect(mgr.peekNextTap()).toEqual({ index: 0, tap: 'fctap0' })

      mgr.seedVmSeq(10)
      expect(mgr.peekNextTap()).toEqual({ index: 10, tap: 'fctap10' })

      // A lower seed must NOT lower the counter (would risk reusing an index).
      mgr.seedVmSeq(3)
      expect(mgr.peekNextTap().index).toBe(10)
    })

    // The end-to-end proof with a REAL FirecrackerVMManager: after a simulated
    // restart, pool startup seeds the manager past the survivor + suspended taps,
    // so the next warm VM the manager would spawn can NEVER reuse either device.
    // This test fails under the old module-global behavior (next tap = fctap0).
    test('a restarted agent seeds a real FC manager past survivor + suspended taps', () => {
      const cfg = makeCfg()

      // Survivors persisted by the previous agent: a live (adopted) VM on fctap7
      // and a suspended (resume-on-demand) VM on fctap9.
      const reg = new LiveRegistry(cfg.runDir)
      reg.put({
        ...entry(cfg, 'live-proj', 111, 'http://127.0.0.1:1'),
        net: { tap: 'fctap7', guestIp: '127.0.0.1' } as any,
      })
      new CacheIndex(cfg.snapDir).put(suspEntry('susp-proj', 'fctap9'))

      const mgr = new FirecrackerVMManager(cfg as any)
      // Before seeding, the fresh agent would hand out fctap0 (the bug).
      expect(mgr.peekNextTap().tap).toBe('fctap0')

      const pool = new MetalWarmPool(mgr as any, cfg as any)
      // The startup seeding step (start() also runs adopt/reconcile around it).
      ;(pool as any).seedVmIndexAllocator()

      // max(7, 9) + 1 → the next warm VM lands on fctap10, clear of BOTH.
      const next = mgr.peekNextTap()
      expect(next).toEqual({ index: 10, tap: 'fctap10' })

      // Explicitly assert the collision-safety invariant: none of the next few
      // allocations reuse a persisted device.
      const heldTaps = new Set(['fctap7', 'fctap9'])
      for (let k = 0; k < 5; k++) {
        expect(heldTaps.has(deriveNet(next.index + k).tap)).toBe(false)
      }
    })

    // A live-only fleet (no suspended snapshots) still seeds past the survivors.
    test('seeds past adopted-only survivors', () => {
      const cfg = makeCfg()
      const reg = new LiveRegistry(cfg.runDir)
      reg.put({ ...entry(cfg, 'a', 1, 'http://127.0.0.1:1'), net: { tap: 'fctap4', guestIp: '127.0.0.1' } as any })
      reg.put({ ...entry(cfg, 'b', 2, 'http://127.0.0.1:1'), net: { tap: 'fctap2', guestIp: '127.0.0.1' } as any })

      const mgr = new FirecrackerVMManager(cfg as any)
      const pool = new MetalWarmPool(mgr as any, cfg as any)
      ;(pool as any).seedVmIndexAllocator()

      expect(mgr.peekNextTap().index).toBe(5) // max(4, 2) + 1
    })

    // An empty fleet (fresh box, first boot) must NOT force the index forward.
    test('no-ops on an empty fleet and ignores unparseable tap names', () => {
      const cfg = makeCfg()
      const reg = new LiveRegistry(cfg.runDir)
      // A malformed / legacy tap name must be ignored, not crash the seed.
      reg.put({ ...entry(cfg, 'weird', 3, 'http://127.0.0.1:1'), net: { tap: 'eth0', guestIp: '127.0.0.1' } as any })

      const mgr = new FirecrackerVMManager(cfg as any)
      const pool = new MetalWarmPool(mgr as any, cfg as any)
      // No host taps either (dev/CI has none, but pin it so the test is hermetic).
      ;(pool as any).hostTapIndices = () => new Set<number>()
      ;(pool as any).seedVmIndexAllocator()

      // Nothing parseable → counter stays at 0 (fresh allocation from fctap0).
      expect(mgr.peekNextTap().index).toBe(0)
    })

    // -------------------------------------------------------------------------
    // Regression: the prod runtime.ext4-rebuild collision (Jul 2026).
    //
    // A rootfs rebuild wiped the durable registries, so the seed above saw an
    // EMPTY fleet (maxIdx = -1) and the counter reset to 0 — even though ~18
    // adopted Firecracker VMs were still running (KillMode=process) holding low
    // fctap<n> devices. Fresh warm VMs then reused those indices; setupTap
    // deleted-then-recreated the devices and blackholed the live guests
    // (duplicate 172.16.0.x mesh IPs, dead guests, agent-proxy/preview 502s).
    // The fix seeds/allocates past the tap devices that PHYSICALLY exist on the
    // host (`ip link`), which survive the registry wipe.
    // -------------------------------------------------------------------------
    test('seeds past live host tap devices even when the registry was wiped', () => {
      const cfg = makeCfg()
      // Registries are EMPTY — a runtime.ext4 rebuild cleared them.
      const mgr = new FirecrackerVMManager(cfg as any)
      const pool = new MetalWarmPool(mgr as any, cfg as any)

      // ...but three microVMs survived on the host with fctap2 / fctap4 / fctap6.
      ;(pool as any).hostTapIndices = () => new Set<number>([2, 4, 6])
      ;(pool as any).seedVmIndexAllocator()

      // Next warm VM lands on fctap7 — clear of every survivor. Under the old
      // registry-only seed this would have been fctap0 (the collision).
      expect(mgr.peekNextTap().index).toBe(7)
    })

    // The manager's allocator is a second line of defense: even if the counter
    // is somehow mis-seeded (or a resumed VM re-took its persisted index mid-run),
    // a fresh spawn must skip any fctap<n> that physically exists right now.
    test('nextVmIndex skips live host tap devices and stays monotonic', () => {
      const cfg = makeCfg()
      const mgr = new FirecrackerVMManager(cfg as any)

      // Counter is at 0 but fctap0 and fctap1 are live on the host → skip to 2.
      ;(mgr as any).hostTapIndices = () => new Set<number>([0, 1])
      expect((mgr as any).nextVmIndex()).toBe(2)

      // Host devices vanish, but the counter never goes backwards (no reuse of
      // an index already handed out this lifetime).
      ;(mgr as any).hostTapIndices = () => new Set<number>()
      expect((mgr as any).nextVmIndex()).toBe(3)

      // A survivor appears exactly at the counter value → jump past it.
      ;(mgr as any).hostTapIndices = () => new Set<number>([4])
      expect((mgr as any).nextVmIndex()).toBe(5)
    })
  })
})
