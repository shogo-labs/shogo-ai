// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// PATCH /projects/:id/publish always-on enforcement: 402 on plan/cap, persist
// on success, and the live min-scale flip. Mocks the route's data + infra deps
// so the handler logic is exercised in isolation.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Run the handler's k8s branch so setPublishedMinScale is exercised.
process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
delete process.env.SHOGO_LOCAL_MODE

type Project = {
  id: string
  workspaceId: string
  publishedSubdomain: string | null
  publishedAlwaysOn: boolean
  publishStatus: string
  accessLevel: string
  siteTitle: string | null
  siteDescription: string | null
  publishedAt: Date | null
}

let projectRow: Project | null = null
const updateCalls: any[] = []

const prismaApi = {
  project: {
    findUnique: async ({ where }: any) => {
      if (projectRow && projectRow.id === where.id) return { ...projectRow }
      return null
    },
    update: async ({ where, data }: any) => {
      updateCalls.push({ where, data })
      if (projectRow && projectRow.id === where.id) Object.assign(projectRow, data)
      return { ...projectRow }
    },
  },
}

// Configurable entitlement gate result + spies.
let gateResult = { allowed: true, planAllows: true, allowance: 1, used: 0 }
const minScaleCalls: Array<{ projectId: string; minScale: number }> = []

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: {},
  BillingInterval: {},
}))
mock.module('../../services/billing.service', () => ({
  canEnableAlwaysOn: async () => gateResult,
  getAlwaysOnAllowanceForWorkspace: async () => gateResult.allowance,
  countAlwaysOnUsed: async () => gateResult.used,
}))
mock.module('../../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({
    setPublishedMinScale: async (projectId: string, minScale: number) => {
      minScaleCalls.push({ projectId, minScale })
    },
  }),
  // Used by the route's internal detectServerBacked() in k8s mode.
  getProjectPodUrl: async () => 'http://pod.local',
}))
mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'tok',
}))
mock.module('../../lib/cloudflare-server-backed-kv', () => ({
  getServerBackedFlag: async () => true,
  setServerBackedFlag: async () => true,
  clearServerBackedFlag: async () => true,
  getServerBackedKvConfig: () => null,
}))

// detectServerBacked() fetches `${podUrl}/agent/server-info`. Make it report
// server-backed so the always-on path is allowed.
const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('/agent/server-info')) {
      return new Response(JSON.stringify({ serverBacked: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  }) as any
  projectRow = {
    id: 'p1',
    workspaceId: 'ws_1',
    publishedSubdomain: 'my-app',
    publishedAlwaysOn: false,
    publishStatus: 'live',
    accessLevel: 'anyone',
    siteTitle: null,
    siteDescription: null,
    publishedAt: new Date(),
  }
  updateCalls.length = 0
  minScaleCalls.length = 0
  gateResult = { allowed: true, planAllows: true, allowance: 1, used: 0 }
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const { publishRoutes } = await import('../publish')
const app = publishRoutes()

function patch(body: any) {
  return app.request('/projects/p1/publish', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH always-on enforcement', () => {
  it('returns 402 plan_not_allowed when the plan grants no slots', async () => {
    gateResult = { allowed: false, planAllows: false, allowance: 0, used: 0 }
    const res = await patch({ alwaysOn: true })
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error.code).toBe('plan_not_allowed')
    // Must not persist or scale on a blocked enable.
    expect(updateCalls.find((c) => 'publishedAlwaysOn' in c.data)).toBeUndefined()
    expect(minScaleCalls).toHaveLength(0)
  })

  it('returns 402 slot_exhausted when the pool is full', async () => {
    gateResult = { allowed: false, planAllows: true, allowance: 1, used: 1 }
    const res = await patch({ alwaysOn: true })
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error.code).toBe('slot_exhausted')
    expect(minScaleCalls).toHaveLength(0)
  })

  it('enables: persists publishedAlwaysOn=true and flips min-scale to 1', async () => {
    gateResult = { allowed: true, planAllows: true, allowance: 2, used: 0 }
    const res = await patch({ alwaysOn: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.alwaysOn).toBe(true)
    expect(projectRow?.publishedAlwaysOn).toBe(true)
    expect(minScaleCalls).toEqual([{ projectId: 'p1', minScale: 1 }])
  })

  it('disables: persists false and flips min-scale to 0 (no entitlement check)', async () => {
    projectRow!.publishedAlwaysOn = true
    const res = await patch({ alwaysOn: false })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.alwaysOn).toBe(false)
    expect(projectRow?.publishedAlwaysOn).toBe(false)
    expect(minScaleCalls).toEqual([{ projectId: 'p1', minScale: 0 }])
  })

  it('404s when the project is not published', async () => {
    projectRow!.publishedSubdomain = null
    const res = await patch({ alwaysOn: true })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('not_published')
  })
})

describe('republish always-on clamp', () => {
  // Run republish on the non-k8s path: it skips the build pipeline and goes
  // straight to the entitlement clamp + persist, which is what we assert.
  let savedHost: string | undefined
  beforeEach(() => {
    savedHost = process.env.KUBERNETES_SERVICE_HOST
    delete process.env.KUBERNETES_SERVICE_HOST
    delete process.env.PROJECT_NAMESPACE
  })
  afterEach(() => {
    if (savedHost !== undefined) process.env.KUBERNETES_SERVICE_HOST = savedHost
  })

  function republish() {
    return app.request('/projects/p1/republish', { method: 'POST' })
  }

  it('clamps publishedAlwaysOn to false when no longer entitled', async () => {
    projectRow!.publishedAlwaysOn = true
    gateResult = { allowed: false, planAllows: true, allowance: 1, used: 1 }
    const res = await republish()
    expect(res.status).toBe(200)
    expect(projectRow?.publishedAlwaysOn).toBe(false)
  })

  it('keeps publishedAlwaysOn=true when still entitled', async () => {
    projectRow!.publishedAlwaysOn = true
    gateResult = { allowed: true, planAllows: true, allowance: 2, used: 1 }
    const res = await republish()
    expect(res.status).toBe(200)
    expect(projectRow?.publishedAlwaysOn).toBe(true)
  })
})
