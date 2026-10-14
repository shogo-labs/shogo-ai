// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool — which workspace members get backed up, and from where.
 *
 * The host's member list for a workspace VM is rebuilt from the caller's env
 * on resume and on a reused open, so backups follow what the guest has
 * mounted — but only for the runtime's own project. A project is online in
 * exactly one runtime (`ws:proj:<id>`); a foreign member a legacy guest still
 * reports is left to `drainForeignMembers` (see pool-single-runtime.test.ts).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { M, metrics } from './metrics'
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

  test('backs up the own project the guest mounted even though the host lost track of it', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:proj:site', 'g1', { workspaceMemberIds: [] })
    guests({ g1: { mounted: ['site'], exports: { '/app/workspace/site': new Uint8Array([2, 2]) } } }, [])

    expect(await pool.saveMembers(a)).toEqual([])
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['site'])
    expect(a.workspaceMemberIds).toEqual(['site'])
  })

  test('never tracks or exports a foreign member the guest reports', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:proj:site', 'g1', { workspaceMemberIds: ['site'] })
    const calls: string[] = []
    guests(
      {
        g1: {
          mounted: ['site', 'other'],
          exports: { '/app/workspace/site': new Uint8Array([1]), '/app/workspace/other': new Uint8Array([2]) },
        },
      },
      calls,
    )
    const before = metrics.getCounter(M.foreignMemberBackupSkipped)
    const error = console.error
    console.error = () => {}
    try {
      expect(await pool.saveMembers(a)).toEqual([])
    } finally {
      console.error = error
    }
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['site'])
    expect(calls).not.toContain('g1 export /app/workspace/other')
    expect(a.workspaceMemberIds).toEqual(['site'])
    expect(metrics.getCounter(M.foreignMemberBackupSkipped)).toBe(before + 1)
  })

  test('keeps backing up the host list when the guest cannot list its members', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:proj:m1', 'g1', { workspaceMemberIds: ['m1'] })
    guests({ g1: { mounted: null, exports: { '/app/workspace/m1': new Uint8Array([1]) } } }, [])

    expect(await pool.saveMembers(a)).toEqual([])
    expect(pool.uploads.map((u) => u.projectId)).toEqual(['m1'])
  })

  test('a member with nothing to export is skipped without failing the backup', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:proj:empty', 'g1', { workspaceMemberIds: ['empty'] })
    guests({ g1: { mounted: ['empty'], exports: {} } }, [])
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: any[]) => void warnings.push(args.join(' '))
    try {
      expect(await pool.saveMembers(a)).toEqual([])
    } finally {
      console.warn = warn
    }
    expect(pool.uploads).toEqual([])
    expect(warnings.some((w) => w.includes('empty') && w.includes('exported nothing'))).toBe(true)
  })

  test('a workspace session runtime backs up no members at all', async () => {
    const pool = makePool(dir)
    const a = pool.add('ws:team', 'g1', { workspaceMemberIds: [] })
    guests({ g1: { mounted: [], exports: {} } }, [])
    expect(await pool.saveMembers(a)).toEqual([])
    expect(pool.uploads).toEqual([])
  })
})
