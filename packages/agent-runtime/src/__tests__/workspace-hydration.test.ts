// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `hydrateWorkspaceMembers` — the cloud per-project hydration step
 * that downloads each workspace member's S3 archive into its own
 * `<WORKSPACE_DIR>/<id>/` subfolder. Pins: per-member sync creation, dedupe,
 * resilience (one failure/unconfigured member never aborts the rest), and that
 * the successfully-hydrated instances are returned for watcher/flush wiring.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/workspace-hydration.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Avoid pulling the heavy real shared-runtime module just to import the unit;
// the production createSync is injected in every test below anyway.
mock.module('@shogo/shared-runtime', () => ({
  createS3SyncForProject: () => null,
}))

const { hydrateWorkspaceMembers } = await import('../workspace-hydration')

const logs: string[] = []
const silentLog = (msg: string) => {
  logs.push(msg)
}

beforeEach(() => {
  logs.length = 0
})

afterEach(() => {
  mock.restore()
})

describe('hydrateWorkspaceMembers', () => {
  test('downloads each member into its own <workspaceDir>/<id> subfolder', async () => {
    const ensured: string[] = []
    const created: Array<{ localDir: string; projectId: string }> = []
    const downloaded: string[] = []

    const result = await hydrateWorkspaceMembers('/app/workspace', ['p1', 'p2'], {
      ensureDir: (dir) => ensured.push(dir),
      createSync: (localDir, projectId) => {
        created.push({ localDir, projectId })
        return {
          downloadAll: async () => {
            downloaded.push(projectId)
            return {}
          },
        }
      },
      log: silentLog,
    })

    expect(ensured).toEqual(['/app/workspace/p1', '/app/workspace/p2'])
    expect(created).toEqual([
      { localDir: '/app/workspace/p1', projectId: 'p1' },
      { localDir: '/app/workspace/p2', projectId: 'p2' },
    ])
    expect(downloaded).toEqual(['p1', 'p2'])
    expect(result.hydrated).toEqual(['p1', 'p2'])
    expect([...result.syncs.keys()]).toEqual(['p1', 'p2'])
  })

  test('dedupes repeated project ids', async () => {
    const created: string[] = []
    const result = await hydrateWorkspaceMembers('/ws', ['p1', 'p1', 'p2'], {
      ensureDir: () => {},
      createSync: (_dir, projectId) => {
        created.push(projectId)
        return { downloadAll: async () => ({}) }
      },
      log: silentLog,
    })
    expect(created).toEqual(['p1', 'p2'])
    expect(result.hydrated).toEqual(['p1', 'p2'])
  })

  test('skips members when S3 is not configured (createSync returns null)', async () => {
    const result = await hydrateWorkspaceMembers('/ws', ['p1', 'p2'], {
      ensureDir: () => {},
      createSync: (_dir, projectId) => (projectId === 'p1' ? null : { downloadAll: async () => ({}) }),
      log: silentLog,
    })
    expect(result.skipped).toEqual(['p1'])
    expect(result.hydrated).toEqual(['p2'])
  })

  test('one member failing does not abort the others', async () => {
    const result = await hydrateWorkspaceMembers('/ws', ['p1', 'p2', 'p3'], {
      ensureDir: () => {},
      createSync: (_dir, projectId) => ({
        downloadAll: async () => {
          if (projectId === 'p2') throw new Error('S3 down')
          return {}
        },
      }),
      log: silentLog,
    })
    expect(result.hydrated).toEqual(['p1', 'p3'])
    expect(result.failed).toEqual(['p2'])
    expect([...result.syncs.keys()]).toEqual(['p1', 'p3'])
  })
})
