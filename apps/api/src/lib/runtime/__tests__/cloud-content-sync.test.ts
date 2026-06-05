// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the desktop cloud ↔ content-sync orchestration
 * (`apps/api/src/lib/runtime/cloud-content-sync.ts`).
 *
 *   bun test apps/api/src/lib/runtime/__tests__/cloud-content-sync.test.ts
 *
 * All filesystem / git / network / watcher dependencies are injected, so the
 * orchestration is exercised without a real cloud, git binary, fs watcher, or
 * Prisma. The registry uses its test store seam; one-writer uses mocked
 * prisma + federated-upstream.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ─── module mocks (resolved relative to cloud-content-sync.ts) ───────────────

const projectFindUniqueMock = mock(async (_: any): Promise<any> => null)
mock.module('../../prisma', () => ({
  prisma: {
    project: { findUnique: projectFindUniqueMock },
    localConfig: { findUnique: async () => null, upsert: async () => {} },
  },
}))

const lookupCloudInstanceMock = mock(async (_: string): Promise<any> => null)
mock.module('../../federated-upstream', () => ({
  lookupCloudInstance: lookupCloudInstanceMock,
}))

const {
  pullCloudProject,
  startCloudSyncWatcher,
  syncCloudProjectIntoDir,
  stopCloudSyncWatcher,
  isCloudSyncActive,
  getCloudSyncStatus,
  isProjectCloudLinked,
  markProjectCloudLinked,
  unmarkProjectCloudLinked,
  getCloudLinkedProjectIds,
  checkSingleWriterWarning,
  _setRegistryStoreForTests,
  _resetCloudContentSyncForTests,
} = await import('../cloud-content-sync')

// ─── helpers ─────────────────────────────────────────────────────────────────

type WatcherOnFlush = (e: { uploaded: string[]; errors: number; committed?: boolean; commitSha?: string }) => void

interface FakeWatcher {
  started: boolean
  stopped: boolean
  start(): void
  stop(): Promise<void>
  fire: WatcherOnFlush
}

function makeFakeWatcher(): { make: (opts: any) => FakeWatcher; last: () => FakeWatcher | null } {
  let last: FakeWatcher | null = null
  return {
    last: () => last,
    make: (opts: any): FakeWatcher => {
      const w: FakeWatcher = {
        started: false,
        stopped: false,
        start() {
          this.started = true
        },
        async stop() {
          this.stopped = true
        },
        fire: (e) => opts.onFlush?.(e),
      }
      last = w
      return w
    },
  }
}

function makeTransport(calls: string[]) {
  return () => ({
    async downloadAll() {
      calls.push('downloadAll')
      return { downloaded: 3, errors: [] as unknown[] }
    },
    async listManifest() {
      calls.push('listManifest')
      return [{ path: '.shogo/state.db' }, { path: 'src/App.tsx' }]
    },
    async downloadFiles(files: Array<{ path: string }>) {
      calls.push(`downloadFiles:${files.length}`)
      return { downloaded: files.length, errors: [] as unknown[] }
    },
  })
}

const BASE = { cloudUrl: 'https://cloud.test', apiKey: 'shogo_sk_test' }

beforeEach(() => {
  _resetCloudContentSyncForTests()
  projectFindUniqueMock.mockReset()
  projectFindUniqueMock.mockImplementation(async () => null)
  lookupCloudInstanceMock.mockReset()
  lookupCloudInstanceMock.mockImplementation(async () => null)
})

// ─── registry ────────────────────────────────────────────────────────────────

describe('cloud-linked registry', () => {
  test('mark / is / get / unmark round-trips through the store', async () => {
    const ids = new Set<string>()
    _setRegistryStoreForTests({
      read: async () => Array.from(ids),
      write: async (next) => {
        ids.clear()
        for (const id of next) ids.add(id)
      },
    })

    expect(await isProjectCloudLinked('p1')).toBe(false)
    await markProjectCloudLinked('p1')
    await markProjectCloudLinked('p2')
    expect(await isProjectCloudLinked('p1')).toBe(true)
    expect((await getCloudLinkedProjectIds()).sort()).toEqual(['p1', 'p2'])

    await unmarkProjectCloudLinked('p1')
    expect(await isProjectCloudLinked('p1')).toBe(false)
    expect(await getCloudLinkedProjectIds()).toEqual(['p2'])
  })

  test('marking is idempotent (no duplicate ids)', async () => {
    const ids = new Set<string>()
    _setRegistryStoreForTests({
      read: async () => Array.from(ids),
      write: async (next) => {
        ids.clear()
        for (const id of next) ids.add(id)
      },
    })
    await markProjectCloudLinked('p1')
    await markProjectCloudLinked('p1')
    expect(await getCloudLinkedProjectIds()).toEqual(['p1'])
  })
})

// ─── pull ──────────────────────────────────────────────────────────────────

describe('pullCloudProject', () => {
  const silent = { log() {}, warn() {}, error() {} }

  test('returns no-credentials (not pulled) when apiKey is missing', async () => {
    const res = await pullCloudProject({ projectId: 'p1', projectDir: '/ws/p1', cloudUrl: 'https://c', apiKey: '', logger: silent })
    expect(res).toMatchObject({ pulled: false, reason: 'no-credentials' })
    expect(getCloudSyncStatus('p1').state).toBe('error')
  })

  test('git available + empty dir → clones and tops up .shogo', async () => {
    const calls: string[] = []
    const cloneProject = mock(async () => ({ commitSha: 'abcdef1234567890' }))
    const res = await pullCloudProject({
      projectId: 'p1',
      projectDir: '/ws/p1',
      ...BASE,
      logger: silent,
      deps: {
        cloneProject: cloneProject as any,
        gitIsAvailable: async () => true,
        isGitRepo: () => false,
        mkdir: () => {},
        dirIsEmpty: () => true,
        makeTransport: makeTransport(calls) as any,
      },
    })
    expect(res).toMatchObject({ pulled: true, mode: 'git' })
    expect(cloneProject).toHaveBeenCalledTimes(1)
    // .shogo top-up runs over the file transport after a git clone.
    expect(calls).toContain('listManifest')
    expect(calls.some((c) => c.startsWith('downloadFiles:'))).toBe(true)
  })

  test('git unavailable → Files API downloadAll (mode=files)', async () => {
    const calls: string[] = []
    const res = await pullCloudProject({
      projectId: 'p1',
      projectDir: '/ws/p1',
      ...BASE,
      logger: silent,
      deps: {
        gitIsAvailable: async () => false,
        isGitRepo: () => false,
        mkdir: () => {},
        dirIsEmpty: () => true,
        makeTransport: makeTransport(calls) as any,
      },
    })
    expect(res).toMatchObject({ pulled: true, mode: 'files' })
    expect(calls).toContain('downloadAll')
  })

  test('git clone throws → falls back to Files API (mode flips to files)', async () => {
    const calls: string[] = []
    const cloneProject = mock(async () => {
      throw new Error('remote hung up')
    })
    const res = await pullCloudProject({
      projectId: 'p1',
      projectDir: '/ws/p1',
      ...BASE,
      logger: silent,
      deps: {
        cloneProject: cloneProject as any,
        gitIsAvailable: async () => true,
        isGitRepo: () => false,
        mkdir: () => {},
        dirIsEmpty: () => true,
        makeTransport: makeTransport(calls) as any,
      },
    })
    expect(res).toMatchObject({ pulled: true, mode: 'files' })
    expect(cloneProject).toHaveBeenCalledTimes(1)
    expect(calls).toContain('downloadAll')
  })

  test('populated non-git dir in files mode → skips download', async () => {
    const calls: string[] = []
    const res = await pullCloudProject({
      projectId: 'p1',
      projectDir: '/ws/p1',
      ...BASE,
      logger: silent,
      deps: {
        gitIsAvailable: async () => false,
        isGitRepo: () => false,
        mkdir: () => {},
        dirIsEmpty: () => false,
        makeTransport: makeTransport(calls) as any,
      },
    })
    expect(res).toMatchObject({ pulled: true })
    expect(calls).not.toContain('downloadAll')
  })

  test('offline (download throws network error) → soft-fail, status offline', async () => {
    const res = await pullCloudProject({
      projectId: 'p1',
      projectDir: '/ws/p1',
      ...BASE,
      logger: silent,
      deps: {
        gitIsAvailable: async () => false,
        isGitRepo: () => false,
        mkdir: () => {},
        dirIsEmpty: () => true,
        makeTransport: () =>
          ({
            async downloadAll() {
              throw new Error('fetch failed')
            },
            async listManifest() {
              return []
            },
            async downloadFiles() {
              return { downloaded: 0, errors: [] }
            },
          }) as any,
      },
    })
    expect(res).toMatchObject({ pulled: false, reason: 'offline' })
    expect(getCloudSyncStatus('p1').state).toBe('offline')
  })
})

// ─── watcher + gating ────────────────────────────────────────────────────────

describe('startCloudSyncWatcher + isCloudSyncActive', () => {
  const silent = { log() {}, warn() {}, error() {} }

  test('starts a watcher, marks sync active, and reflects onFlush in status', async () => {
    const calls: string[] = []
    const fake = makeFakeWatcher()
    expect(isCloudSyncActive('p1')).toBe(false)

    startCloudSyncWatcher({
      projectId: 'p1',
      projectDir: '/ws/p1',
      ...BASE,
      mode: 'git',
      logger: silent,
      deps: { makeWatcher: fake.make as any, makeTransport: makeTransport(calls) as any },
    })

    expect(fake.last()?.started).toBe(true)
    expect(isCloudSyncActive('p1')).toBe(true)
    expect(getCloudSyncStatus('p1').state).toBe('watching')

    // Successful flush → still watching, with a push timestamp + commit.
    fake.last()!.fire({ uploaded: ['a.ts'], errors: 0, committed: true, commitSha: 'deadbeef' })
    expect(getCloudSyncStatus('p1').lastPushCommit).toBe('deadbeef')
    expect(getCloudSyncStatus('p1').lastPushAt).toBeGreaterThan(0)

    // Failed flush → error state.
    fake.last()!.fire({ uploaded: [], errors: 2 })
    expect(getCloudSyncStatus('p1').state).toBe('error')
  })

  test('is idempotent — a second start does not create a second watcher', async () => {
    const fakeA = makeFakeWatcher()
    const fakeB = makeFakeWatcher()
    startCloudSyncWatcher({ projectId: 'p1', projectDir: '/ws/p1', ...BASE, mode: 'files', deps: { makeWatcher: fakeA.make as any, makeTransport: makeTransport([]) as any } })
    startCloudSyncWatcher({ projectId: 'p1', projectDir: '/ws/p1', ...BASE, mode: 'files', deps: { makeWatcher: fakeB.make as any, makeTransport: makeTransport([]) as any } })
    expect(fakeA.last()?.started).toBe(true)
    expect(fakeB.last()).toBeNull()
  })

  test('stopCloudSyncWatcher stops the watcher and clears the active flag', async () => {
    const fake = makeFakeWatcher()
    startCloudSyncWatcher({ projectId: 'p1', projectDir: '/ws/p1', ...BASE, mode: 'files', deps: { makeWatcher: fake.make as any, makeTransport: makeTransport([]) as any } })
    await stopCloudSyncWatcher('p1')
    expect(fake.last()?.stopped).toBe(true)
    expect(isCloudSyncActive('p1')).toBe(false)
  })
})

// ─── orchestration: pull + watch ─────────────────────────────────────────────

describe('syncCloudProjectIntoDir', () => {
  const silent = { log() {}, warn() {}, error() {} }

  test('successful pull starts the watcher (sync active)', async () => {
    const fake = makeFakeWatcher()
    const res = await syncCloudProjectIntoDir({
      projectId: 'p1',
      projectDir: '/ws/p1',
      ...BASE,
      logger: silent,
      deps: {
        gitIsAvailable: async () => false,
        isGitRepo: () => false,
        mkdir: () => {},
        dirIsEmpty: () => true,
        makeTransport: makeTransport([]) as any,
        makeWatcher: fake.make as any,
      },
    })
    expect(res.pulled).toBe(true)
    expect(isCloudSyncActive('p1')).toBe(true)
    expect(fake.last()?.started).toBe(true)
  })

  test('failed pull does NOT start a watcher (never pushes a local fallback up)', async () => {
    const fake = makeFakeWatcher()
    const res = await syncCloudProjectIntoDir({
      projectId: 'p1',
      projectDir: '/ws/p1',
      ...BASE,
      logger: silent,
      deps: {
        gitIsAvailable: async () => false,
        isGitRepo: () => false,
        mkdir: () => {},
        dirIsEmpty: () => true,
        makeTransport: () =>
          ({
            async downloadAll() {
              throw new Error('fetch failed')
            },
            async listManifest() {
              return []
            },
            async downloadFiles() {
              return { downloaded: 0, errors: [] }
            },
          }) as any,
        makeWatcher: fake.make as any,
      },
    })
    expect(res.pulled).toBe(false)
    expect(isCloudSyncActive('p1')).toBe(false)
    expect(fake.last()).toBeNull()
  })
})

// ─── one-writer guard ────────────────────────────────────────────────────────

describe('checkSingleWriterWarning', () => {
  const silent = { log() {}, warn() {}, error() {} }

  test('null when the project is not pinned to an instance', async () => {
    projectFindUniqueMock.mockImplementation(async () => ({ preferredInstanceId: null }))
    expect(await checkSingleWriterWarning('p1', silent)).toBeNull()
    expect(getCloudSyncStatus('p1').conflictWarning).toBeUndefined()
  })

  test('warns when pinned to an ONLINE cloud worker', async () => {
    projectFindUniqueMock.mockImplementation(async () => ({ preferredInstanceId: 'inst-1' }))
    lookupCloudInstanceMock.mockImplementation(async () => ({ id: 'inst-1', name: 'devbox', status: 'online' }))
    const warning = await checkSingleWriterWarning('p1', silent)
    expect(warning).toContain('devbox')
    expect(getCloudSyncStatus('p1').conflictWarning).toContain('devbox')
  })

  test('null when the pinned worker is offline', async () => {
    projectFindUniqueMock.mockImplementation(async () => ({ preferredInstanceId: 'inst-1' }))
    lookupCloudInstanceMock.mockImplementation(async () => ({ id: 'inst-1', name: 'devbox', status: 'offline' }))
    expect(await checkSingleWriterWarning('p1', silent)).toBeNull()
  })
})
