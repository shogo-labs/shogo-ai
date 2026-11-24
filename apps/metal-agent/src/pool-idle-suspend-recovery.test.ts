// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-540 — a refused VM must recover and suspend by itself.
 *
 * The export behind `repoDurable` failed deterministically, so a VM that could
 * never satisfy it was refused on every idle pass for the rest of its life
 * (~11k refusals/day across the fleet, and 139 VMs pinned on staging). Two
 * ways out, both tested here through the reaper's own surfaces:
 *   - a runtime whose root has no git repo says so, and its cached HEAD is
 *     cleared instead of pinning it,
 *   - an export that succeeds makes that HEAD durable, so the next idle pass
 *     suspends the VM.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmConfig, FcVmHandle, FirecrackerVMManager } from './firecracker-vm-manager'
import { MetalWarmPool, type AssignedVm, type RepoExport } from './pool'
import type { RepoLineage, RepoWriteOutcome } from './repo-archive'
import type { SnapshotStore } from './snapshot-store'

const IDLE_MS = 1000
const HEAD = 'a'.repeat(40)

class TestPool extends MetalWarmPool {
  suspends: string[] = []
  saves = 0
  exportBytes: Uint8Array | null = new Uint8Array([1, 2, 3])
  uploads: Array<{ projectId: string; opts: { lineage: RepoLineage } }> = []

  override async suspend(projectId: string): Promise<any> {
    this.suspends.push(projectId)
    ;(this as any).assigned.delete(projectId)
    return { projectId }
  }

  protected override async guestHasRepoBundles(): Promise<boolean> {
    return false
  }

  protected override async statDurableRepo() {
    return null
  }

  protected override async fetchRepoExport(): Promise<RepoExport | null> {
    return this.exportBytes ? { bytes: this.exportBytes, rootCommitAt: null } : null
  }

  protected override async uploadRepoGuarded(
    projectId: string,
    _bytes: Uint8Array,
    opts: { lineage: RepoLineage; preserveOnRefusal?: boolean },
  ): Promise<RepoWriteOutcome> {
    this.uploads.push({ projectId, opts })
    return { status: 'written', etag: '"repo-1"' }
  }

  override async saveRepoToStore(a: AssignedVm): Promise<boolean> {
    this.saves++
    return super.saveRepoToStore(a)
  }

  seed(projectId: string, fields: Partial<AssignedVm> = {}): AssignedVm {
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle: { id: `vm-${projectId}`, agentUrl: 'http://127.0.0.1:1', guestIp: '127.0.0.1' } as any,
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      alwaysOn: false,
      perClassActivity: true,
      runtimeToken: 'tok',
      ...fields,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }

  peek(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }

  resident(): string[] {
    return [...(this as any).assigned.keys()].sort()
  }
}

let dir: string
const cfg = config as { -readonly [K in keyof typeof config]: (typeof config)[K] }
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sho540-'))
  cfg.idleSuspendMs = IDLE_MS
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
})

function makePool(over: Partial<MetalConfig> = {}): TestPool {
  const c = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    poolSize: 0,
    idleSuspendMs: IDLE_MS,
    activityPoll: true,
    activityTimeoutMs: 500,
    ...over,
  } as MetalConfig
  mkdirSync(c.snapDir, { recursive: true })
  mkdirSync(c.runDir, { recursive: true })
  const mgr = {
    async startVM(vmCfg: FcVmConfig = {}): Promise<FcVmHandle> {
      return {
        id: 'vm-x',
        agentUrl: 'http://127.0.0.1:1',
        guestIp: '127.0.0.1',
        pid: 1,
        platform: 'linux',
        net: { tap: 'fctap0', guestIp: '127.0.0.1' } as any,
        rootfs: join(dir, 'rootfs'),
        socketPath: join(dir, 'fc.sock'),
        serialLog: join(dir, 'fc.serial'),
        vcpus: vmCfg.cpus ?? 2,
        memoryMB: vmCfg.memoryMB ?? 1024,
        vmClass: vmCfg.vmClass ?? 'standard',
      }
    },
    async stopVM(): Promise<void> {},
    isRunning: () => true,
    procCount: () => 0,
    durableRootfs: (p: string) => ({ path: p, mode: 'full' }),
    restoreRootfsArtifactPath: (p: string) => p,
  } as unknown as FirecrackerVMManager
  const pool = new TestPool(mgr, c, { kind: 'none' } as unknown as SnapshotStore)
  for (const m of [
    'waitForHealth',
    'hydrateFromBackup',
    'hydrateProjectData',
    'hydrateRepoAtAssign',
    'hydrateHomeState',
    'hydratePublishedData',
    'saveBackupToStore',
    'saveProjectDataToStore',
    'saveHomeStateToStore',
    'callGuestHook',
  ]) {
    ;(pool as any)[m] = async () => ({ hydrated: false })
  }
  return pool
}

/** What the guest's `/pool/activity` answers — the exact shape `pollActivity` parses. */
function guestReport(overrides: Record<string, unknown>) {
  return (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          lastRequestAt: 1,
          activeStreams: 0,
          busy: false,
          activeTurns: 0,
          liveStreams: 0,
          lastAppRequestAt: null,
          lastAgentRequestAt: null,
          ...overrides,
        }),
        { status: 200 },
      ),
    )) as unknown as typeof fetch
}

describe('a runtime with no root repo is not refused for durability', () => {
  test('the guest saying repoPresent:false clears a HEAD cached from an earlier boot', async () => {
    const pool = makePool()
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('ws:proj:anchor', {
      repoHeadSha: HEAD,
      repoExportedHeadSha: undefined,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      assignedAt: old,
    })
    // Before the report: a HEAD nobody can export -> refused, forever.
    expect(pool.repoDurable(a)).toBe(false)

    globalThis.fetch = guestReport({ repoPresent: false, repoHeadSha: null })
    await pool.pollActivity()

    expect(a.repoAbsent).toBe(true)
    expect(a.repoHeadSha).toBeUndefined()
    expect(pool.repoDurable(a)).toBe(true)
    // The very next idle pass suspends it instead of refusing it.
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['ws:proj:anchor'])
    expect(pool.resident()).toEqual([])
  })

  test('the sweep stops asking for an export it can never get', async () => {
    const pool = makePool()
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('ws:proj:anchor', { repoHeadSha: HEAD, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = guestReport({ repoPresent: false, repoHeadSha: null })
    await pool.pollActivity()
    pool.saves = 0

    expect(await pool.exportAllRepos()).toBe(0)
    expect(pool.saves).toBe(0)
    expect(a.repoAbsent).toBe(true)
  })

  test('a runtime that regains a repo starts exporting again', async () => {
    const pool = makePool()
    const a = pool.seed('p1', { repoHeadSha: HEAD, repoAbsent: true })

    globalThis.fetch = guestReport({ repoPresent: true, repoHeadSha: HEAD })
    await pool.pollActivity()

    expect(a.repoAbsent).toBe(false)
    expect(a.repoHeadSha).toBe(HEAD)
  })
})

describe('an export that lands makes the VM suspendable', () => {
  test('the sweep records the exported HEAD, and the next idle pass suspends', async () => {
    const pool = makePool()
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('p1', {
      repoHeadSha: HEAD,
      lastTouchedAt: old,
      lastRealActivityAt: old,
      assignedAt: old,
    })
    expect(pool.repoDurable(a)).toBe(false)

    globalThis.fetch = guestReport({ repoPresent: true, repoHeadSha: HEAD })
    await pool.pollActivity()
    await pool.exportAllRepos()

    expect(pool.uploads).toHaveLength(1)
    expect(a.repoExportedHeadSha).toBe(HEAD)
    expect(pool.repoDurable(a)).toBe(true)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['p1'])
  })
})
