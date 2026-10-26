// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-138: "I deleted my project" has to mean the site is gone. The delete hook
// is the ONE place every delete path goes through, so the published-site
// teardown lands there — and `beforeDelete` has to stash the subdomain, because
// `afterDelete` runs once the row (and its `publishedSubdomain`) is gone. These
// tests pin both halves plus the two ways this must not break a delete: no
// subdomain recorded, and a teardown that throws.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// The delete hook only runs the cloud (substrate + published-site) teardown off
// desktop. The bun test env loads the repo's local `.env`, which sets this.
delete process.env.SHOGO_LOCAL_MODE

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const PROJECT_ID = 'proj-138'

const teardownCalls: Array<{ projectId: string; subdomain: string; opts?: unknown }> = []
let teardownThrows = false
const destroyedRuntimes: string[] = []
const removedAgents: string[] = []

/** Per-test project row returned by `prisma.project.findUnique`. */
let projectRow: { workspaceId: string; publishedSubdomain: string | null } | null = {
  workspaceId: WORKSPACE_ID,
  publishedSubdomain: 'my-live-site',
}

const prisma = {
  user: { findUnique: async () => ({ role: 'super_admin' }) },
  member: { findMany: async () => [{ role: 'owner', projectId: null, isBillingAdmin: false }] },
  project: {
    findUnique: async () => (projectRow ? { id: PROJECT_ID, ...projectRow } : null),
  },
  chatSession: { findMany: async () => [] },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma }))

mock.module('../services/published-site-teardown', () => ({
  teardownPublishedSite: async (projectId: string, subdomain: string, opts?: unknown) => {
    teardownCalls.push({ projectId, subdomain, opts })
    if (teardownThrows) throw new Error('teardown exploded')
    return [{ step: 'runtime', ok: true }]
  },
}))

mock.module('../services/conversation.service', () => ({
  removeProjectAgent: async (projectId: string) => {
    removedAgents.push(projectId)
  },
}))

mock.module('../lib/substrate', () => ({
  destroyProjectRuntime: async (projectId: string) => {
    destroyedRuntimes.push(projectId)
  },
}))

const { projectHooks } = await import('../generated/project.hooks')

function makeCtx(): any {
  return { body: {}, params: {}, query: {}, userId: USER_ID, prisma }
}

/** A delete is: beforeDelete (row still there) → row delete → afterDelete. */
async function runDelete(id: string) {
  const before = await projectHooks.beforeDelete!(id, makeCtx())
  // The route only calls afterDelete once the row is actually gone.
  projectRow = null
  await projectHooks.afterDelete!(id, makeCtx())
  return before
}

beforeEach(() => {
  teardownCalls.length = 0
  destroyedRuntimes.length = 0
  removedAgents.length = 0
  teardownThrows = false
  projectRow = { workspaceId: WORKSPACE_ID, publishedSubdomain: 'my-live-site' }
})

describe('projectHooks delete — published site teardown', () => {
  test('a deleted published project tears its site down with the recorded subdomain, purging its data', async () => {
    const before = await runDelete(PROJECT_ID)

    expect((before as any).ok).toBe(true)
    expect(teardownCalls).toEqual([
      {
        projectId: PROJECT_ID,
        subdomain: 'my-live-site',
        opts: { purgePublishedData: true, dropPublishPointer: false },
      },
    ])
    // The runtime destroy still happens — it owns a different set of resources.
    expect(destroyedRuntimes).toEqual([PROJECT_ID])
    expect(removedAgents).toEqual([PROJECT_ID])
  })

  test('a project that was never published deletes without a teardown', async () => {
    projectRow = { workspaceId: WORKSPACE_ID, publishedSubdomain: null }

    await runDelete(PROJECT_ID)

    expect(teardownCalls).toEqual([])
    expect(destroyedRuntimes).toEqual([PROJECT_ID])
  })

  test('a throwing teardown never blocks the delete or the runtime destroy', async () => {
    teardownThrows = true

    await expect(runDelete(PROJECT_ID)).resolves.toBeTruthy()

    expect(teardownCalls).toHaveLength(1)
    // afterDelete catches, so the rest of the cleanup still ran.
    expect(destroyedRuntimes).toEqual([PROJECT_ID])
  })

  test('a delete that never saw the row (already gone) has no site to tear down', async () => {
    projectRow = null

    await runDelete(PROJECT_ID)

    expect(teardownCalls).toEqual([])
  })
})
