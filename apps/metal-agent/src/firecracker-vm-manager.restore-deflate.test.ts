// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A restored VM must get its RAM back (SHO-534, QA round 1).
 *
 * The snapshot path inflates the balloon, so the balloon is part of the vmstate
 * and comes back up with the guest. The old gate only deflated after restore when
 * `METAL_SNAP_BALLOON` was on — so a host running **idle reclaim with the
 * snapshot balloon off** (`METAL_IDLE_RECLAIM=1`, `METAL_SNAP_BALLOON=0`) restored
 * a guest with its balloon still inflated and *no one able to deflate it*: the
 * pool hands the restored VM a fresh `AssignedVm` with no `balloonedMiB`, so
 * `touch()` no-ops, and the guest runs its first turn short of RAM until a full
 * idle window re-seeds the accounting.
 *
 * Runs the real `restoreVM` against a stubbed Firecracker socket: the only
 * host-side step it skips is the tap (CAP_NET_ADMIN), and spawning the FC child.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { FirecrackerVMManager, type FcSnapshot } from './firecracker-vm-manager'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A manager whose FC child and tap are stubbed away; everything else is real. */
class TestMgr extends FirecrackerVMManager {
  protected setupRestoreTap(): void {}
  /** restoreVM reads the pid back out of `procs`, so register a fake one. */
  spawnFc(id: string, _socketPath: string, _serialLog: string): any {
    const proc = { pid: 4242, kill: () => {} }
    ;(this as any).procs.set(id, proc)
    return proc
  }
  async waitForSocket() {}
}

function makeMgr(flags: { balloonReclaim?: boolean; idleReclaim?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'fc-restore-deflate-'))
  dirs.push(dir)
  // restore refuses a snapshot whose rootfs backing file is gone, so give it one.
  const rootfs = join(dir, 'rootfs.img')
  writeFileSync(rootfs, 'rootfs')
  return {
    mgr: new TestMgr({
      ...config,
      work: dir,
      snapDir: join(dir, 'snap'),
      runDir: join(dir, 'run'),
      balloonReclaim: flags.balloonReclaim ?? false,
      idleReclaim: flags.idleReclaim ?? false,
    } as typeof config),
    rootfs,
  }
}

function snapshot(rootfs: string): FcSnapshot {
  return {
    vmId: 'vm-old',
    snapshotPath: '/tmp/fake.vmstate',
    memFilePath: '/tmp/fake.mem',
    net: {
      tap: 'fctap0',
      hostIp: '172.16.0.1',
      guestIp: '172.16.0.2',
      netmask: '255.255.255.252',
      guestMac: '06:00:AC:10:00:02',
      bootIpArg: 'ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off',
    },
    rootfs,
    vcpus: 2,
    memoryMB: 4096,
    createdAt: Date.now(),
    bytesMem: 0,
    bytesState: 0,
    bytesRootfs: 0,
    vmClass: 'standard',
  } as FcSnapshot
}

/** Record what the restore sends to Firecracker; answer everything with 204. */
async function restore({ mgr, rootfs }: ReturnType<typeof makeMgr>) {
  const realFetch = globalThis.fetch
  const calls: Array<{ method?: string; path: string; body?: any }> = []
  globalThis.fetch = (async (url: any, init: any = {}) => {
    calls.push({
      method: init.method,
      path: String(url).replace(/^http:\/\/localhost/, ''),
      body: init.body ? JSON.parse(init.body) : undefined,
    })
    return new Response(null, { status: 204 })
  }) as any
  try {
    const handle = await mgr.restoreVM(snapshot(rootfs))
    // The deflate is fire-and-forget: give it a tick to reach the socket.
    await Bun.sleep(20)
    return { handle, calls, balloon: calls.filter((c) => c.path === '/balloon') }
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('restoreVM balloon deflate', () => {
  test('idle reclaim alone deflates the balloon the snapshot left up', async () => {
    // The regression: METAL_SNAP_BALLOON=0 but METAL_IDLE_RECLAIM=1.
    const { handle, calls, balloon } = await restore(makeMgr({ idleReclaim: true }))

    expect(calls.some((c) => c.path === '/snapshot/load')).toBe(true)
    expect(balloon).toEqual([{ method: 'PATCH', path: '/balloon', body: { amount_mib: 0 } }])
    expect(handle.memoryMB).toBe(4096)
  })

  test('the snapshot balloon alone still deflates it (unchanged)', async () => {
    const { balloon } = await restore(makeMgr({ balloonReclaim: true }))
    expect(balloon).toEqual([{ method: 'PATCH', path: '/balloon', body: { amount_mib: 0 } }])
  })

  test('with every flag off the restore sends nothing extra (byte-identical)', async () => {
    const { calls } = await restore(makeMgr({}))
    expect(calls.some((c) => c.path === '/snapshot/load')).toBe(true)
    expect(calls.filter((c) => c.path === '/balloon')).toEqual([])
  })
})
