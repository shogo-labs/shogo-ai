// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/jobs/published-usage.ts (SHO-345).
//
// The bug this guards against: `withGlobalJobLock` is a per-region advisory
// lock, so both regions ran the collector, both inserted the same
// (environmentId, minute) key with different ids, and logical replication
// disabled itself with `insert_exists`. The tests below pin the replacement
// contract:
//   * one collection per region-minute (second tick is a no-op: no pod list,
//     no write),
//   * ownership by workspace home region for BOTH collect and bill,
//   * one namespace-wide pod list per tick rather than one per environment,
//   * no row for a scaled-to-zero environment,
//   * unchanged billing totals,
//   * a no-op outside Kubernetes (local / desktop).

import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface FakeEnv {
  id: string
  projectId: string
  name: string
  /** The workspace home region of the environment's project. */
  homeRegion: string | null
  workspaceId: string
}

let envs: FakeEnv[] = []
let lastEnvFindManyArgs: any = null
let lastProjectFindManyArgs: any = null
let homeFilterImpl: any = null

// Region-scoped claim rows, exactly what PlatformSetting holds in prod.
let settings = new Map<string, string>()
let lastSettingsUpdateArgs: any = null

let podCounts = new Map<string, number>()
let podListCalls = 0

let usageRows: any[] = []
let lastUsageCreateMany: any = null
let lastUsageFindManyArgs: any = null
let lastUsageUpdates: any[] = []

let pendingRows: any[] = []

let consumeCalls: any[] = []
let consumeResult: any = { success: true }

function matchesHome(env: FakeEnv, where: any): boolean {
  if (!where) return true
  // A `Workspace` where-fragment: { homeRegion } | { OR: [{ homeRegion }|{ homeRegion: null }] }
  const workspace = where.project?.workspace
  if (!workspace) return true
  if (Array.isArray(workspace.OR)) {
    return workspace.OR.some((c: any) =>
      c.homeRegion === null ? env.homeRegion === null : env.homeRegion === c.homeRegion,
    )
  }
  return env.homeRegion === workspace.homeRegion
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    publishedEnvironment: {
      findMany: async (args: any) => {
        lastEnvFindManyArgs = args
        return envs.map((e) => ({ id: e.id, projectId: e.projectId, name: e.name }))
      },
      findUnique: async (args: any) => {
        const env = envs.find((e) => e.id === args.where.id)
        return env ? { ...env, minReplicas: 0, maxReplicas: 1, size: 's' } : null
      },
    },
    project: {
      findMany: async (args: any) => {
        lastProjectFindManyArgs = args
        const ids: string[] = args.where.id?.in ?? []
        const workspace = args.where.workspace
        return envs
          .filter((e) => ids.includes(e.projectId) && matchesHome(e, { project: { workspace } }))
          .map((e) => ({ id: e.projectId }))
      },
      findUnique: async (args: any) => {
        const env = envs.find((e) => e.projectId === args.where.id)
        return env ? { workspaceId: env.workspaceId } : null
      },
    },
    platformSetting: {
      createMany: async (args: any) => {
        let count = 0
        for (const row of args.data) {
          if (settings.has(row.key)) continue
          settings.set(row.key, row.value)
          count++
        }
        return { count }
      },
      updateMany: async (args: any) => {
        lastSettingsUpdateArgs = args
        const current = settings.get(args.where.key)
        if (current === undefined) return { count: 0 }
        // Mirror `value < args.data.value` (lexicographic on fixed-width ISO).
        if (!(current < args.data.value)) return { count: 0 }
        settings.set(args.where.key, args.data.value)
        return { count: 1 }
      },
    },
    publishedUsageMinute: {
      createMany: async (args: any) => {
        lastUsageCreateMany = args
        for (const row of args.data) {
          usageRows.push({ id: `row-${usageRows.length}`, ...row })
        }
        return { count: args.data.length }
      },
      findMany: async (args: any) => {
        lastUsageFindManyArgs = args
        const allowed: string[] | undefined = args.where.environmentId?.in
        return pendingRows.filter(
          (r) =>
            r.billedAt === null &&
            (!allowed || allowed.includes(r.environmentId)) &&
            r.minute < args.where.minute.lt,
        )
      },
      updateMany: async (args: any) => {
        lastUsageUpdates.push(args)
        for (const row of pendingRows) {
          if (args.where.id.in.includes(row.id)) row.billedAt = args.data.billedAt
        }
        return { count: args.where.id.in.length }
      },
    },
  },
}))

mock.module('../../lib/region', () => ({
  REGION_ID: 'eu-frankfurt-1',
  homeRegionWorkspaceWhere: () => homeFilterImpl,
}))

// The lock is kept only as a region-local serialiser; in tests run the body.
mock.module('../../lib/global-job-lock', () => ({
  withGlobalJobLock: async (_name: string, body: () => Promise<any>) => ({
    acquired: true,
    result: await body(),
  }),
}))

mock.module('../../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({
    listPublishedPodCounts: async () => {
      podListCalls++
      return podCounts
    },
    listPublishedPods: async () => {
      throw new Error('listPublishedPods must not be called per environment any more')
    },
  }),
}))

mock.module('../../services/published-environments.service', () => ({
  scaleSettingsOf: () => ({ size: 's', minReplicas: 0, maxReplicas: 1 }),
}))

mock.module('../../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeCalls.push(args)
    return consumeResult
  },
}))

mock.module('../../services/published-ops.service', () => ({
  applyExhaustedWalletClamp: async () => [],
}))

mock.module('../../lib/project-user-context', () => ({
  getProjectOwnerUserId: async () => 'member-1',
}))

const { runPublishedUsageCollect, runPublishedUsageBill } = await import('../published-usage')
const { publishedServiceName } = await import('../../lib/published-scale')

const MINUTE = new Date('2026-11-05T15:54:00.000Z')

function env(id: string, homeRegion: string | null = null): FakeEnv {
  return { id, projectId: `p-${id}`, name: 'production', homeRegion, workspaceId: `w-${id}` }
}

beforeEach(() => {
  delete process.env.KUBERNETES_SERVICE_HOST
  process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
  envs = []
  lastEnvFindManyArgs = null
  lastProjectFindManyArgs = null
  homeFilterImpl = null
  settings = new Map()
  lastSettingsUpdateArgs = null
  podCounts = new Map()
  podListCalls = 0
  usageRows = []
  lastUsageCreateMany = null
  lastUsageFindManyArgs = null
  lastUsageUpdates = []
  pendingRows = []
  consumeCalls = []
  consumeResult = { success: true }
})

describe('runPublishedUsageCollect', () => {
  it('is a no-op outside Kubernetes (local / desktop)', async () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    const s = await runPublishedUsageCollect(MINUTE)
    expect(s).toEqual({ environments: 0, rowsWritten: 0, skipped: true })
    expect(podListCalls).toBe(0)
    expect(lastUsageCreateMany).toBeNull()
  })

  it('collects a minute once: the second pod in the same region and minute is skipped with no pod list and no write', async () => {
    envs = [env('penv_1')]
    podCounts = new Map([[publishedServiceName('p-penv_1', 'production'), 2]])

    const first = await runPublishedUsageCollect(MINUTE)
    expect(first).toEqual({ environments: 1, rowsWritten: 1, skipped: false })
    expect(podListCalls).toBe(1)
    expect(usageRows).toHaveLength(1)
    expect(usageRows[0]).toMatchObject({ environmentId: 'penv_1', podSeconds: 120 })

    podListCalls = 0
    lastUsageCreateMany = null
    const second = await runPublishedUsageCollect(MINUTE)
    expect(second.skipped).toBe(true)
    expect(second.rowsWritten).toBe(0)
    expect(podListCalls).toBe(0)
    expect(lastUsageCreateMany).toBeNull()
  })

  it('claims via a per-region PlatformSetting key', async () => {
    envs = [env('penv_1')]
    podCounts = new Map([[publishedServiceName('p-penv_1', 'production'), 1]])
    await runPublishedUsageCollect(MINUTE)
    expect(settings.get('published-usage:last-collected:eu-frankfurt-1')).toBe(
      MINUTE.toISOString(),
    )
  })

  it('re-collects a later minute after an earlier claim', async () => {
    envs = [env('penv_1')]
    podCounts = new Map([[publishedServiceName('p-penv_1', 'production'), 1]])
    expect((await runPublishedUsageCollect(MINUTE)).rowsWritten).toBe(1)
    expect((await runPublishedUsageCollect(new Date('2026-11-05T15:55:00.000Z'))).rowsWritten).toBe(1)
    expect(lastSettingsUpdateArgs.where.value.lt).toBe('2026-11-05T15:55:00.000Z')
  })

  it('lists pods once per tick regardless of environment count', async () => {
    envs = [env('a'), env('b'), env('c'), env('d')]
    podCounts = new Map([
      [publishedServiceName('p-a', 'production'), 1],
      [publishedServiceName('p-b', 'production'), 1],
    ])
    const s = await runPublishedUsageCollect(MINUTE)
    expect(podListCalls).toBe(1)
    expect(s.environments).toBe(4)
    expect(s.rowsWritten).toBe(2)
  })

  it('writes no row for an environment with zero ready pods', async () => {
    envs = [env('idle')]
    podCounts = new Map()
    const s = await runPublishedUsageCollect(MINUTE)
    expect(s.rowsWritten).toBe(0)
    expect(lastUsageCreateMany).toBeNull()
    expect(usageRows).toHaveLength(0)
  })

  it('collects only environments homed in this region; null-homeRegion belongs to the primary', async () => {
    homeFilterImpl = { homeRegion: 'eu-frankfurt-1' }
    envs = [env('eu', 'eu-frankfurt-1'), env('us', 'us-ashburn-1'), env('legacy', null)]
    podCounts = new Map([
      [publishedServiceName('p-eu', 'production'), 1],
      [publishedServiceName('p-us', 'production'), 1],
      [publishedServiceName('p-legacy', 'production'), 1],
    ])
    await runPublishedUsageCollect(MINUTE)

    expect(lastProjectFindManyArgs.where).toEqual({
      id: { in: ['p-eu', 'p-us', 'p-legacy'] },
      workspace: { homeRegion: 'eu-frankfurt-1' },
    })
    expect(usageRows.map((r) => r.environmentId)).toEqual(['eu'])

    // ...and the primary also owns the null-homeRegion rows.
    homeFilterImpl = { OR: [{ homeRegion: 'us-ashburn-1' }, { homeRegion: null }] }
    usageRows = []
    settings = new Map()
    const s = await runPublishedUsageCollect(MINUTE)
    expect(s.rowsWritten).toBe(2) // 'us' + 'legacy'
  })

  it('applies no home filter in single-region / local mode', async () => {
    homeFilterImpl = null
    envs = [env('a')]
    podCounts = new Map([[publishedServiceName('p-a', 'production'), 1]])
    await runPublishedUsageCollect(MINUTE)
    expect(lastEnvFindManyArgs.where).toBeUndefined()
    expect(lastProjectFindManyArgs).toBeNull()
  })
})

describe('runPublishedUsageBill', () => {
  const HOUR_LATER = new Date('2026-11-05T16:54:00.000Z')

  it('bills only the environments homed in this region', async () => {
    homeFilterImpl = { homeRegion: 'eu-frankfurt-1' }
    envs = [env('eu', 'eu-frankfurt-1'), env('us', 'us-ashburn-1')]
    pendingRows = [
      { id: 'r1', environmentId: 'eu', minute: MINUTE, podSeconds: 60, egressBytes: 0n, dbStorageBytes: 0n, billedAt: null },
      { id: 'r2', environmentId: 'us', minute: MINUTE, podSeconds: 60, egressBytes: 0n, dbStorageBytes: 0n, billedAt: null },
    ]

    const s = await runPublishedUsageBill(HOUR_LATER)

    expect(lastUsageFindManyArgs.where.environmentId).toEqual({ in: ['eu'] })
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].projectId).toBe('p-eu')
    expect(s.environmentsCharged).toBe(1)
    expect(s.rowsBilled).toBe(1)
    // The peer's row is untouched: its own region bills it.
    expect(pendingRows.find((r) => r.id === 'r2')!.billedAt).toBeNull()
  })

  it('bills every environment when not multi-region', async () => {
    homeFilterImpl = null
    envs = [env('a'), env('b')]
    pendingRows = [
      { id: 'r1', environmentId: 'a', minute: MINUTE, podSeconds: 60, egressBytes: 0n, dbStorageBytes: 0n, billedAt: null },
      { id: 'r2', environmentId: 'b', minute: MINUTE, podSeconds: 60, egressBytes: 0n, dbStorageBytes: 0n, billedAt: null },
    ]
    const s = await runPublishedUsageBill(HOUR_LATER)
    expect(lastUsageFindManyArgs.where.environmentId).toBeUndefined()
    expect(s.environmentsCharged).toBe(2)
  })

  it('charges the same amount for the same collected pod-seconds, in either home region', async () => {
    const { computePublishedCost, roundUsd } = await import('../../config/published-pricing')
    // 3 rows × 60s = 180 pod-seconds at size s — the aggregation the old
    // per-region job also did, so the amount must not move.
    const expected = roundUsd(
      computePublishedCost({ podSeconds: { s: 180 }, egressBytes: 0, dbStorageBytes: 0, monthFraction: 0 }).podUsd,
    )
    expect(expected).toBeGreaterThan(0)

    for (const home of ['eu-frankfurt-1', 'us-ashburn-1']) {
      consumeCalls = []
      usageRows = []
      pendingRows = []
      homeFilterImpl = { homeRegion: home }
      const e = env('shared', home)
      e.projectId = 'p-shared'
      envs = [e]
      pendingRows = [0, 1, 2].map((i) => ({
        id: `r${i}`,
        environmentId: 'shared',
        minute: MINUTE,
        podSeconds: 60,
        egressBytes: 0n,
        dbStorageBytes: 0n,
        billedAt: null,
      }))

      const s = await runPublishedUsageBill(HOUR_LATER)
      expect(consumeCalls).toHaveLength(1)
      expect(consumeCalls[0].billedUsd).toBe(expected)
      expect(consumeCalls[0].actionMetadata.podSeconds).toEqual({ s: 180 })
      expect(s.totalUsd).toBe(expected)
      // Charged once: rows carry billedAt, so a rerun bills nothing.
      const rerun = await runPublishedUsageBill(HOUR_LATER)
      expect(rerun.rowsBilled).toBe(0)
      expect(consumeCalls).toHaveLength(1)
    }
  })
})
