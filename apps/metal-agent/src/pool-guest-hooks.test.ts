// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — guest lifecycle hooks around a memory snapshot.
 *
 * `/pool/quiesce` stops the guest's API sidecars before the snapshot and
 * `/pool/rehydrate` restarts them after the resume. Both routes sit behind the
 * guest's runtime-token auth once a VM is assigned, so the host must send the
 * token or the hooks silently do nothing.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmHandle } from './firecracker-vm-manager'
import { MetalWarmPool } from './pool'
import type { SnapshotStore } from './snapshot-store'

const dirs: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A local guest that records every /pool/* call with its auth header. */
function makeGuest() {
  const calls: Array<{ path: string; auth: string | null }> = []
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname
      if (path.startsWith('/pool/')) calls.push({ path, auth: req.headers.get('authorization') })
      if (path === '/pool/export' || path === '/pool/export-data' || path === '/pool/export-repo') {
        return new Response(null, { status: 204 })
      }
      return Response.json({ ok: true })
    },
  })
  cleanups.push(() => server.stop(true))
  return { port: server.port!, calls }
}

function fakeMgr(guestPort: number, opts: { snapshotFails?: boolean } = {}) {
  let n = 0
  const handle = (): FcVmHandle => {
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
      vcpus: 2,
      memoryMB: 1024,
      vmClass: 'standard',
    } as FcVmHandle
  }
  return {
    startVM: async () => handle(),
    restoreVM: async () => handle(),
    stopVM: async () => {},
    isRunning: () => true,
    procCount: () => 0,
    reapHostOrphans: () => 0,
    snapshotVM: async (h: FcVmHandle) => {
      if (opts.snapshotFails) throw new Error('firecracker snapshot failed')
      return {
        vmId: h.id,
        snapshotPath: '/tmp/x.vmstate',
        memFilePath: '/tmp/x.mem',
        net: h.net,
        rootfs: h.rootfs,
        vcpus: h.vcpus,
        memoryMB: h.memoryMB,
        createdAt: Date.now(),
        bytesMem: 0,
        bytesState: 0,
        bytesRootfs: 0,
        vmClass: h.vmClass,
      }
    },
    durableRootfs: () => ({ path: '/tmp/x.rootfs', mode: 'full' }),
    restoreRootfsArtifactPath: (p: string) => p,
  }
}

function makeCfg(): MetalConfig {
  const dir = mkdtempSync(join(tmpdir(), 'pool-hooks-'))
  dirs.push(dir)
  const snapDir = join(dir, 'snap')
  const runDir = join(dir, 'run')
  mkdirSync(snapDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  return { ...config, work: dir, snapDir, runDir, poolSize: 0, snapStore: 'none' } as MetalConfig
}

const ENV = { RUNTIME_AUTH_SECRET: 'tok-123' }

describe('guest lifecycle hooks', () => {
  test('suspend quiesces the guest with its runtime token before snapshotting', async () => {
    const guest = makeGuest()
    const pool = new MetalWarmPool(fakeMgr(guest.port) as any, makeCfg(), { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()
    await pool.assign('proj-a', ENV)
    guest.calls.length = 0

    await pool.suspend('proj-a')
    const quiesce = guest.calls.find((c) => c.path === '/pool/quiesce')
    expect(quiesce).toEqual({ path: '/pool/quiesce', auth: 'Bearer tok-123' })
    // Quiesce is the last guest call before the freeze: backups run first,
    // while the sidecar is still up.
    expect(guest.calls.at(-1)?.path).toBe('/pool/quiesce')
  })

  test('a failed snapshot rehydrates the still-running guest', async () => {
    const guest = makeGuest()
    const pool = new MetalWarmPool(
      fakeMgr(guest.port, { snapshotFails: true }) as any,
      makeCfg(),
      { kind: 'none' } as unknown as SnapshotStore,
    )
    await pool.start()
    await pool.assign('proj-a', ENV)
    guest.calls.length = 0

    await expect(pool.suspend('proj-a')).rejects.toThrow(/snapshot failed/)
    const paths = guest.calls.map((c) => c.path)
    expect(paths.slice(-2)).toEqual(['/pool/quiesce', '/pool/rehydrate'])
    expect(guest.calls.at(-1)?.auth).toBe('Bearer tok-123')
    expect(pool.status().assigned.map((a: any) => a.projectId)).toEqual(['proj-a'])
  })

  test('resume rehydrates after the env refresh, with the token', async () => {
    const guest = makeGuest()
    const pool = new MetalWarmPool(fakeMgr(guest.port) as any, makeCfg(), { kind: 'none' } as unknown as SnapshotStore)
    await pool.start()
    await pool.assign('proj-a', ENV)
    await pool.suspend('proj-a')
    guest.calls.length = 0

    const r = await pool.resume('proj-a', ENV)
    expect(r?.source).toBe('local')
    const paths = guest.calls.map((c) => c.path)
    expect(paths.indexOf('/pool/refresh-env')).toBeGreaterThanOrEqual(0)
    expect(paths.indexOf('/pool/rehydrate')).toBeGreaterThan(paths.indexOf('/pool/refresh-env'))
    expect(guest.calls.find((c) => c.path === '/pool/rehydrate')?.auth).toBe('Bearer tok-123')
  })
})
