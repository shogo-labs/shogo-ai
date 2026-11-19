// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool.ensureWorkspaceDriveSize — the live workspace-drive grow (SHO-349) and
 * its convergence path (SHO-401).
 *
 * The bug SHO-401 fixes: a grow whose `PATCH /drives` failed left the backing
 * file grown but the guest at the old size, and every later open answered
 * `unchanged` because the no-op check only compared the file. These tests pin
 * the three behaviours that matter: a real grow reports from/to, a drive whose
 * file is already big but whose guest is behind converges, and a PATCH failure
 * still thaws the guest.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const MiB = 1024 * 1024

class TestPool extends MetalWarmPool {
  seed(projectId: string, drivePath: string): AssignedVm {
    const a: AssignedVm = {
      projectId,
      handle: {
        id: `vm-${projectId}`,
        agentUrl: 'http://10.0.0.9:8080',
        guestIp: '10.0.0.9',
        socketPath: '/tmp/fake-fc.sock',
        workspaceDrive: drivePath,
      } as any,
      assignedAt: 0,
      lastTouchedAt: Date.now(),
      alwaysOn: false,
      runtimeToken: 'rt_test',
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }
}

function makePool(dir: string): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    workspaceDriveMiB: 20 * 1024,
    workspaceDriveMaxMiB: 200 * 1024,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0 } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

interface GuestState {
  totalBytes: number
  ops: string[]
  patchFails?: boolean
}

/** Route guest HTTP and Firecracker socket calls through one fetch mock. */
function installFetch(guest: GuestState) {
  const realFetch = globalThis.fetch
  const calls: { kind: 'guest' | 'fc'; method: string; path: string; body?: any }[] = []
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    if (init.unix) {
      // Firecracker REST over the Unix socket.
      const path = u.replace(/^http:\/\/localhost/, '')
      calls.push({ kind: 'fc', method, path, body: init.body ? JSON.parse(init.body) : undefined })
      if (path.startsWith('/drives/') && method === 'PATCH' && guest.patchFails) {
        return new Response('missing field drive_id', { status: 400 })
      }
      return new Response(null, { status: 204 })
    }
    const path = u.replace(/^http:\/\/[^/]+/, '')
    calls.push({ kind: 'guest', method, path, body: init.body ? JSON.parse(init.body) : undefined })
    if (path === '/pool/workspace-drive' && method === 'GET') {
      return Response.json({ usedBytes: 0, totalBytes: guest.totalBytes })
    }
    if (path === '/pool/workspace-drive' && method === 'POST') {
      const op = JSON.parse(init.body).op as string
      guest.ops.push(op)
      return Response.json({ ok: true })
    }
    return new Response(null, { status: 204 })
  }) as any
  return { calls, restore: () => (globalThis.fetch = realFetch) }
}

describe('pool.ensureWorkspaceDriveSize', () => {
  let dir: string
  let drive: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-wsdrive-'))
    drive = join(dir, 'vm1.ws.ext4')
    writeFileSync(drive, Buffer.alloc(4 * MiB, 7))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('grows the file and reports {fromMiB,toMiB}', async () => {
    const pool = makePool(dir)
    const a = pool.seed('p1', drive)
    const guest: GuestState = { totalBytes: 4 * MiB, ops: [] }
    const f = installFetch(guest)
    try {
      const res = await pool.ensureWorkspaceDriveSize(a, 20 * 1024)
      expect(res).toEqual({ fromMiB: 4, toMiB: 20 * 1024 })
      // The PATCH body must carry drive_id (SHO-401).
      const patch = f.calls.find((c) => c.kind === 'fc' && c.method === 'PATCH')
      expect(patch?.body).toEqual({ drive_id: 'workspace', path_on_host: drive })
      expect(guest.ops).toEqual(['freeze', 'thaw', 'resize'])
    } finally {
      f.restore()
    }
  })

  test('converges when the file is already big but the guest is behind', async () => {
    const pool = makePool(dir)
    // Simulate the broken state: file grown to 20 GiB, guest still at 4 GiB.
    writeFileSync(drive, Buffer.alloc(0))
    const { ftruncateSync, openSync, closeSync } = await import('fs')
    const fd = openSync(drive, 'r+')
    ftruncateSync(fd, 20 * 1024 * MiB)
    closeSync(fd)

    const a = pool.seed('p1', drive)
    const guest: GuestState = { totalBytes: 4 * MiB, ops: [] }
    const f = installFetch(guest)
    try {
      const res = await pool.ensureWorkspaceDriveSize(a, 20 * 1024)
      expect(res).toEqual({ fromMiB: 4, toMiB: 20 * 1024 })
      // No ftruncate on the converge path — the file was already the right size.
      expect(guest.ops).toEqual(['freeze', 'thaw', 'resize'])
      const patch = f.calls.find((c) => c.kind === 'fc' && c.method === 'PATCH')
      expect(patch?.body).toEqual({ drive_id: 'workspace', path_on_host: drive })
    } finally {
      f.restore()
    }
  })

  test('is a no-op when the guest already matches the file', async () => {
    const pool = makePool(dir)
    const a = pool.seed('p1', drive)
    const guest: GuestState = { totalBytes: 4 * MiB, ops: [] }
    const f = installFetch(guest)
    try {
      expect(await pool.ensureWorkspaceDriveSize(a, 4)).toBe('unchanged')
      expect(guest.ops).toEqual([])
    } finally {
      f.restore()
    }
  })

  test('a PATCH failure still thaws the guest', async () => {
    const pool = makePool(dir)
    const a = pool.seed('p1', drive)
    const guest: GuestState = { totalBytes: 4 * MiB, ops: [], patchFails: true }
    const f = installFetch(guest)
    try {
      await expect(pool.ensureWorkspaceDriveSize(a, 20 * 1024)).rejects.toThrow()
      // freeze, then the finally-block thaw — never left frozen.
      expect(guest.ops).toEqual(['freeze', 'thaw'])
    } finally {
      f.restore()
    }
  })
})
