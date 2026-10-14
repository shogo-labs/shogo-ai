// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — remote workspace members. A remote member lives only in its own
 * project's runtime: mounting it into the workspace agent's VM copies
 * nothing, and the VM never backs it up, so there is one copy of the project.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { BackupWriteOutcome } from './workspace-archive'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

class TestPool extends MetalWarmPool {
  uploads: string[] = []
  sourceLookups: string[] = []

  protected override async uploadBackupGuarded(projectId: string): Promise<BackupWriteOutcome> {
    this.uploads.push(projectId)
    return { status: 'created', etag: `"${projectId}"` }
  }

  add(key: string, extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = {
      projectId: key,
      handle: { id: 'vm-g1', agentUrl: 'http://g1:8080', guestIp: 'g1' },
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(key, a)
    ;(this as any).sourceRef = async (id: string) => {
      this.sourceLookups.push(id)
      return null
    }
    return a
  }

  saveMembers(a: AssignedVm) {
    return (this as any).saveWorkspaceMembersToStore(a) as Promise<Array<{ projectId: string; reason: string }>>
  }
}

function makePool(dir: string): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    hydrateTimeoutMs: 5000,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

type Member = { id: string; remote?: boolean }

/** A guest holding `members`; `supportsRemote: false` mimics an image from before remote members. */
function guest(members: Member[], calls: string[], supportsRemote = true) {
  globalThis.fetch = mock(async (url: any, init: any) => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${u.pathname}`)
    if (u.pathname === '/internal/workspace/members' && method === 'GET') {
      return Response.json({ mounted: members })
    }
    if (u.pathname === '/internal/workspace/members' && method === 'POST') {
      const body = JSON.parse(init.body)
      const member = { id: body.id, ...(supportsRemote && body.remote ? { remote: true } : {}) }
      members.push(member)
      return Response.json({ ok: true, member })
    }
    if (u.pathname.startsWith('/internal/workspace/members/') && method === 'DELETE') {
      const id = decodeURIComponent(u.pathname.split('/').pop()!)
      members.splice(members.findIndex((m) => m.id === id), 1)
      return Response.json({ ok: true })
    }
    if (u.pathname === '/pool/export') {
      return new Response(new Uint8Array([1]))
    }
    return new Response('unexpected', { status: 500 })
  }) as any
}

describe('remote workspace members', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-remote-members-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('mounting copies nothing onto the VM and tracks the member as remote', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:team', { workspaceMemberIds: [] })
    const calls: string[] = []
    guest([], calls)

    expect(await pool.mountWorkspaceMember('ws:team', 'site', '/app/workspace/site', { remote: true })).toEqual({
      hydrated: false,
      remote: true,
    })

    expect(pool.sourceLookups).toEqual([])
    expect(calls).not.toContain('POST /pool/apply')
    expect(a.remoteMemberIds).toEqual(['site'])
    expect(a.workspaceMemberIds).toEqual([])
  })

  test('backups skip remote members', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:team', { workspaceMemberIds: ['local'], remoteMemberIds: ['site'] })
    guest([{ id: 'local' }, { id: 'site', remote: true }], [])

    expect(await pool.saveMembers(a)).toEqual([])
    expect(pool.uploads).toEqual(['local'])
    expect(a.workspaceMemberIds).toEqual(['local'])
  })

  test('a project already mounted as a copy stays a copy', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:team', { workspaceMemberIds: ['site'] })
    const calls: string[] = []
    guest([{ id: 'site' }], calls)

    expect(await pool.mountWorkspaceMember('ws:team', 'site', '/app/workspace/site', { remote: true })).toEqual({
      hydrated: false,
      remote: false,
    })
    expect(calls).toEqual(['GET /internal/workspace/members'])
    expect(a.workspaceMemberIds).toEqual(['site'])
    expect(a.remoteMemberIds).toBeUndefined()
  })

  test('a guest without remote support is rolled back, leaving no empty folder to back up', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:team', { workspaceMemberIds: [] })
    const members: Member[] = []
    const calls: string[] = []
    guest(members, calls, false)

    await expect(
      pool.mountWorkspaceMember('ws:team', 'site', '/app/workspace/site', { remote: true }),
    ).rejects.toThrow('does not support remote members')
    expect(calls).toContain('DELETE /internal/workspace/members/site')
    expect(members).toEqual([])
    expect(a.workspaceMemberIds).toEqual([])
    expect(a.remoteMemberIds).toBeUndefined()
  })

  test('unmounting a remote member exports nothing', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:team', { workspaceMemberIds: [], remoteMemberIds: ['site'] })
    const calls: string[] = []
    guest([{ id: 'site', remote: true }], calls)

    expect(await pool.unmountWorkspaceMember('ws:team', 'site', '/app/workspace/site')).toEqual({ exported: false })
    expect(calls).toEqual(['DELETE /internal/workspace/members/site'])
    expect(pool.uploads).toEqual([])
    expect(a.remoteMemberIds).toEqual([])
  })

  test('after an agent restart, the guest still marks the member remote', async () => {
    const pool = makePool(dir)
    pool.add('ws:team', { workspaceMemberIds: [] })
    const calls: string[] = []
    guest([{ id: 'site', remote: true }], calls)

    expect(await pool.unmountWorkspaceMember('ws:team', 'site', '/app/workspace/site')).toEqual({ exported: false })
    expect(calls).not.toContain('POST /pool/export')
  })
})
