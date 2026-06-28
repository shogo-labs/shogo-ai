// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// publishProject() Pro+ subdomain gate: a first publish or a subdomain change
// is blocked with 402 plan_not_allowed for free/basic, while republishing the
// SAME subdomain stays allowed (so a downgraded workspace keeps its site
// updatable). Runs the non-k8s path so the build pipeline is skipped and the
// gate + persist logic is exercised in isolation.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Non-k8s path: skip the build/upload pipeline, go straight to gate + persist.
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

let projectRow: Project | null = null
const updateCalls: any[] = []

const prismaApi = {
  project: {
    findUnique: async ({ where }: any) => {
      if (where.id && projectRow && projectRow.id === where.id) return { ...projectRow }
      // Uniqueness check by publishedSubdomain — report available (null).
      if (where.publishedSubdomain) return null
      return null
    },
    update: async ({ where, data }: any) => {
      updateCalls.push({ where, data })
      if (projectRow && projectRow.id === where.id) Object.assign(projectRow, data)
      return { ...projectRow }
    },
  },
  customDomain: {
    findMany: async () => [],
  },
}

// Configurable plan gate result.
let canPublish = true

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: {},
  BillingInterval: {},
}))
mock.module('../../services/billing.service', () => ({
  canPublishSubdomain: async () => canPublish,
  canEnableAlwaysOn: async () => ({ allowed: true, planAllows: true, allowance: 1, used: 0 }),
  getAlwaysOnAllowanceForWorkspace: async () => 1,
  countAlwaysOnUsed: async () => 0,
}))
mock.module('../../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({}),
  // flushGitSync() resolves the pod URL; the fetch below returns no sha so
  // tagPublishedCommit() gracefully no-ops and the publish still succeeds.
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
beforeEach(() => {
  // git-flush returns an empty body (no sha) -> tagPublishedCommit returns null.
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as any
  projectRow = {
    id: 'p1',
    workspaceId: 'ws_1',
    publishedSubdomain: null,
    publishedAlwaysOn: false,
    publishStatus: 'idle',
    accessLevel: 'anyone',
    sitePasswordHash: null,
    siteTitle: null,
    siteDescription: null,
    publishedAt: null,
  }
  updateCalls.length = 0
  canPublish = true
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const { publishProject } = await import('../publish')

describe('publishProject subdomain Pro+ gate', () => {
  it('blocks a first publish for free/basic with 402 plan_not_allowed', async () => {
    canPublish = false
    const res = await publishProject('p1', { subdomain: 'my-app' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(402)
    expect(res.code).toBe('plan_not_allowed')
    // Must not persist a publish on a blocked attempt.
    expect(updateCalls).toHaveLength(0)
    expect(projectRow?.publishedSubdomain).toBeNull()
  })

  it('blocks a subdomain CHANGE for free/basic with 402 plan_not_allowed', async () => {
    canPublish = false
    projectRow!.publishedSubdomain = 'old-app'
    const res = await publishProject('p1', { subdomain: 'new-app' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(402)
    expect(res.code).toBe('plan_not_allowed')
    expect(updateCalls).toHaveLength(0)
    expect(projectRow?.publishedSubdomain).toBe('old-app')
  })

  it('allows republishing the SAME subdomain even when the plan cannot publish', async () => {
    canPublish = false
    projectRow!.publishedSubdomain = 'my-app'
    const res = await publishProject('p1', { subdomain: 'my-app' })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(res.subdomain).toBe('my-app')
    expect(updateCalls.length).toBeGreaterThan(0)
  })

  it('allows a first publish for Pro+', async () => {
    canPublish = true
    const res = await publishProject('p1', { subdomain: 'my-app' })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(res.subdomain).toBe('my-app')
    expect(projectRow?.publishedSubdomain).toBe('my-app')
  })
})
