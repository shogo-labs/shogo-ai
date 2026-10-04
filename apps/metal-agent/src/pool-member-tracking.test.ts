// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — which workspace members get backed up, and from where.
 *
 * The host's member list for a workspace VM is rebuilt from the caller's env
 * on resume and on a reused open, and that env never includes projects
 * mounted live. A project cloned into a team-chat VM was never exported
 * because of it, and opening the same project in Studio meanwhile started a
 * second VM from the starter. Backups now follow what the guest has mounted,
 * and a runtime that hydrates a project first flushes it from any other live
 * VM on the host that holds it.
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

type Guest = { mounted: string[] | null; exports: Record<string, Uint8Array | null> }

class TestPool extends MetalWarmPool {
  uploads: Array<{ projectId: string; bytes: Uint8Array; parentEtag?: string }> = []

  protected override async uploadBackupGuarded(
    projectId: string,
    bytes: Uint8Array,
    opts: { parentEtag?: string },
  ): Promise<BackupWriteOutcome> {
    this.uploads.push({ projectId, bytes, parentEtag: opts.parentEtag })
    return { status: opts.parentEtag ? 'written' : 'created', etag: `"${projectId}-${this.uploads.length}"` }
  }

  add(key: string, host: string, extra: Partial<AssignedVm> = {}): AssignedVm {
    const a = {
      projectId: key,
      handle: { id: `vm-${host}`, agentUrl: `http://${host}:8080`, guestIp: host },
      assignedAt: Date.now(),
      lastTouchedAt: Date.now(),
      runtimeToken: 'tok',
      ...extra,
    } as AssignedVm
    ;(this as any).assigned.set(key, a)
    return a
  }

  saveMembers(a: AssignedVm) {
    return (this as any).saveWorkspaceMembersToStore(a) as Promise<Array<{ projectId: string; reason: string }>>
  }

  flush(runtimeKey: string, memberIds: string[]) {
    return (this as any).flushMembersHeldElsewhere(runtimeKey, memberIds) as Promise<void>
  }
}

function makePool(dir: string, running: (id: string) => boolean = () => true): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    hydrateTimeoutMs: 5000,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: (h: { id: string }) => running(h.id) } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

/** Guests keyed by host: answer the member listing and per-folder exports. */
function guests(byHost: Record<string, Guest>, calls: string[]) {
  globalThis.fetch = mock(async (url: any, init: any) => {
    const u = new URL(String(url))
    const guest = byHost[u.hostname]
    if (!guest) return new Response('no guest', { status: 502 })
    if (u.pathname === '/internal/workspace/members') {
      calls.push(`${u.hostname} list`)
      if (!guest.mounted) return new Response('not found', { status: 404 })
      return Response.json({ mounted: guest.mounted.map((id) => ({ id })) })
    }
    if (u.pathname === '/pool/export') {
      const dir = init?.body ? JSON.parse(init.body).dir : undefined
      calls.push(`${u.hostname} export ${dir}`)
      const bytes = guest.exports[dir]
      return bytes ? new Response(bytes) : new Response(null, { status: 204 })
    }
    return new Response('unexpected', { status: 500 })
  }) as any
}

describe('workspace member backups follow the guest', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-member-tracking-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('backs up a member the guest mounted live even though the host lost track of it', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:team', 'g1', { workspaceMemberIds: ['m1'] })
    const calls: string[] = []
    guests(
      {
        g1: {
          mounted: ['m1', 'site'],
          exports: { '/app/workspace/m1': new Uint8Array([1]), '/app/workspace/site': new Uint8Array([2, 2]) },
        },
      },
      calls,
    )

    expect(await pool.saveMembers(a)).toEqual([])
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['m1', 'site'])
    expect(a.workspaceMemberIds).toEqual(['m1', 'site'])
  })

  test('keeps backing up the host list when the guest cannot list its members', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:team', 'g1', { workspaceMemberIds: ['m1'] })
    guests({ g1: { mounted: null, exports: { '/app/workspace/m1': new Uint8Array([1]) } } }, [])

    expect(await pool.saveMembers(a)).toEqual([])
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['m1'])
  })

  test('a member with nothing to export is skipped without failing the others', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:team', 'g1', { workspaceMemberIds: ['empty', 'm1'] })
    guests({ g1: { mounted: ['empty', 'm1'], exports: { '/app/workspace/m1': new Uint8Array([1]) } } }, [])
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: any[]) => void warnings.push(args.join(' '))
    try {
      expect(await pool.saveMembers(a)).toEqual([])
    } finally {
      console.warn = warn
    }
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['m1'])
    expect(warnings.some((w) => w.includes('empty') && w.includes('exported nothing'))).toBe(true)
  })
})

describe('opening a project another live VM holds', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-member-flush-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('flushes it from that VM first, even when only the guest knows it is mounted', async () => {
    const pool = makePool(dir)
    const team = pool.add('ws:team', 'g1', { workspaceMemberIds: [] })
    pool.add('ws:proj:other', 'g2', { workspaceMemberIds: ['other'] })
    const calls: string[] = []
    guests(
      {
        g1: { mounted: ['site'], exports: { '/app/workspace/site': new Uint8Array([7, 7, 7]) } },
        g2: { mounted: ['other'], exports: { '/app/workspace/other': new Uint8Array([9]) } },
      },
      calls,
    )

    await pool.flush('ws:proj:site', ['site'])

    expect(pool.uploads).toEqual([{ projectId: 'site', bytes: new Uint8Array([7, 7, 7]), parentEtag: undefined }])
    expect(calls).not.toContain('g2 export /app/workspace/other')
    // The VM now tracks the member and holds its new lineage.
    expect(team.workspaceMemberIds).toEqual(['site'])
    expect(team.memberData?.site?.sourceParentEtag).toBe('"site-1"')
  })

  test('skips the runtime being opened and VMs whose process is gone', async () => {
    const pool = makePool(dir, (id) => id !== 'vm-g2')
    pool.add('ws:proj:site', 'g1', { workspaceMemberIds: ['site'] })
    pool.add('ws:team', 'g2', { workspaceMemberIds: ['site'] })
    const calls: string[] = []
    guests(
      {
        g1: { mounted: ['site'], exports: { '/app/workspace/site': new Uint8Array([1]) } },
        g2: { mounted: ['site'], exports: { '/app/workspace/site': new Uint8Array([2]) } },
      },
      calls,
    )

    await pool.flush('ws:proj:site', ['site'])

    expect(pool.uploads).toEqual([])
    expect(calls).toEqual([])
  })

  test('a VM that fails to export never fails the open', async () => {
    const pool = makePool(dir)
    pool.add('ws:team', 'g1', { workspaceMemberIds: ['site'] })
    globalThis.fetch = mock(async (url: any) => {
      if (String(url).endsWith('/internal/workspace/members')) return Response.json({ mounted: [{ id: 'site' }] })
      return new Response('boom', { status: 500 })
    }) as any

    await pool.flush('ws:proj:site', ['site'])
    expect(pool.uploads).toEqual([])
  })
})
