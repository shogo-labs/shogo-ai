// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// publishProject() per-subdomain in-flight claim (SHO-207).
//
// The DB availability check only sees COMMITTED reservations, and
// `publishedSubdomain` is written at the END of the pipeline. Two projects
// publishing the same name concurrently therefore both passed the check, both
// uploaded into the same `{subdomain}/` prefix (the loser overwriting the
// winner's files), and the unique constraint only rejected the second write
// afterwards. These tests pin the claim that closes that window.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Non-k8s path: skip the build/upload pipeline so the claim + persist logic is
// exercised in isolation.
delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.PROJECT_NAMESPACE
delete process.env.SHOGO_LOCAL_MODE

type Project = {
  id: string
  workspaceId: string
  publishedSubdomain: string | null
  publishedAlwaysOn: boolean
  publishStatus: string
  accessLevel: string
  sitePasswordHash: string | null
  siteTitle: string | null
  siteDescription: string | null
  publishedAt: Date | null
}

const projects = new Map<string, Project>()
const updateCalls: Array<{ where: any; data: any }> = []
/** Resolves once the first project's persist is reached. */
let onFirstPersist: (() => void) | null = null
/** When set, the persist for this project id awaits `persistGate` before writing. */
let persistGateFor: string | null = null
let persistGate: Promise<void> | null = null
/** When set, the persist for this project id throws. */
let failPersistFor: string | null = null

function seed(id: string, publishedSubdomain: string | null = null): Project {
  const row: Project = {
    id,
    workspaceId: 'ws_1',
    publishedSubdomain,
    publishedAlwaysOn: false,
    publishStatus: 'idle',
    accessLevel: 'anyone',
    sitePasswordHash: null,
    siteTitle: null,
    siteDescription: null,
    publishedAt: null,
  }
  projects.set(id, row)
  return row
}

const prismaApi = {
  project: {
    findUnique: async ({ where }: any) => {
      if (where.id) {
        const row = projects.get(where.id)
        return row ? { ...row } : null
      }
      // Uniqueness check by publishedSubdomain — only committed rows are found.
      if (where.publishedSubdomain) {
        for (const row of projects.values()) {
          if (row.publishedSubdomain === where.publishedSubdomain) return { id: row.id }
        }
        return null
      }
      return null
    },
    update: async ({ where, data }: any) => {
      updateCalls.push({ where, data })
      if (failPersistFor && failPersistFor === where.id) {
        failPersistFor = null
        throw new Error('db exploded mid-persist')
      }
      onFirstPersist?.()
      onFirstPersist = null
      if (persistGate && persistGateFor === where.id) await persistGate
      const row = projects.get(where.id)
      if (row) Object.assign(row, data)
      return row ? { ...row } : null
    },
  },
  customDomain: {
    findMany: async () => [],
  },
}

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: {},
  BillingInterval: {},
}))
mock.module('../../services/billing.service', () => ({
  canPublishSubdomain: async () => true,
  canEnableAlwaysOn: async () => ({ allowed: true, planAllows: true, allowance: 1, used: 0 }),
  getAlwaysOnAllowanceForWorkspace: async () => 1,
  countAlwaysOnUsed: async () => 0,
}))
mock.module('../../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({}),
  getProjectPodUrl: async () => 'http://pod.local',
}))
mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'tok',
}))
mock.module('../../lib/cloudflare-site-auth-kv', () => ({
  setSitePassword: async () => {},
  clearSitePassword: async () => {},
  hashSitePassword: () => 'hash',
}))

const realFetch = globalThis.fetch
let fetchCalls = 0

beforeEach(() => {
  // tagPublishedCommit()'s git flush: empty body -> no sha -> it no-ops.
  fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    return new Response('{}', { status: 200 })
  }) as any
  projects.clear()
  updateCalls.length = 0
  onFirstPersist = null
  persistGate = null
  persistGateFor = null
  failPersistFor = null
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const { publishProject } = await import('../publish')

/** Let queued microtasks/macrotasks run until `done()` is true. */
async function until(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (done()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('publishProject subdomain claim', () => {
  it('rejects a concurrent publish of the same subdomain with 409 and does no work', async () => {
    seed('p1')
    seed('p2')

    // Hold p1 inside its persist, i.e. AFTER it took the claim and did the
    // expensive work but BEFORE publishedSubdomain is committed.
    let releasePersist!: () => void
    persistGateFor = 'p1'
    persistGate = new Promise<void>((r) => {
      releasePersist = r
    })
    let p1ReachedPersist!: () => void
    const reached = new Promise<void>((r) => {
      p1ReachedPersist = r
    })
    onFirstPersist = p1ReachedPersist

    const aPromise = publishProject('p1', { subdomain: 'contested' })
    await reached

    // p2 passes the DB check (p1's row is not committed yet) and must lose.
    const b = await publishProject('p2', { subdomain: 'contested' })
    expect(b.ok).toBe(false)
    expect(b.status).toBe(409)
    expect(b.code).toBe('subdomain_taken')

    // The loser persisted nothing and never tagged a commit.
    expect(updateCalls.filter((c) => c.where.id === 'p2')).toHaveLength(0)
    expect(projects.get('p2')!.publishedSubdomain).toBeNull()
    expect(fetchCalls).toBe(1) // only p1's tagPublishedCommit reached the pod

    releasePersist()
    const a = await aPromise
    expect(a.ok).toBe(true)
    expect(projects.get('p1')!.publishedSubdomain).toBe('contested')
  })

  it('releases the claim when a publish fails, so the next project can take it', async () => {
    seed('p1')
    seed('p2')

    failPersistFor = 'p1'
    const a = await publishProject('p1', { subdomain: 'free-after-fail' })
    expect(a.ok).toBe(false)
    expect(a.status).toBe(500)

    // The claim must not survive the failure.
    const b = await publishProject('p2', { subdomain: 'free-after-fail' })
    expect(b.ok).toBe(true)
    expect(b.subdomain).toBe('free-after-fail')
    expect(projects.get('p2')!.publishedSubdomain).toBe('free-after-fail')
  })

  it('does not block a project republishing its own subdomain', async () => {
    seed('p1', 'mine')

    const a = await publishProject('p1', { subdomain: 'mine' })
    const b = await publishProject('p1', { subdomain: 'mine' })

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(projects.get('p1')!.publishedSubdomain).toBe('mine')
  })

  it('still refuses a subdomain another project already committed', async () => {
    seed('p1', 'taken')
    seed('p2')

    const res = await publishProject('p2', { subdomain: 'taken' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(res.code).toBe('subdomain_taken')
    expect(updateCalls).toHaveLength(0)
  })

  it('releases the claim after a successful publish', async () => {
    seed('p1')
    seed('p2')

    expect((await publishProject('p1', { subdomain: 'serial' })).ok).toBe(true)
    // p1 now holds the DB row, so p2 is refused by the DB check — but the
    // claim must also be gone, which we prove by publishing a fresh name.
    expect((await publishProject('p2', { subdomain: 'serial' })).code).toBe('subdomain_taken')
    expect((await publishProject('p2', { subdomain: 'other' })).ok).toBe(true)
  })
})
