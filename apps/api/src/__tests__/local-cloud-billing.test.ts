// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const findUniqueMock = mock(async (_args: any): Promise<any> => null)
const fetchUpstreamMock = mock(async (_path: string, _init?: any): Promise<Response> => {
  return new Response('{}', { status: 200 })
})
const markIfConfirmedMock = mock(async (_reason: string, _key?: string | null) => true)

mock.module('../lib/prisma', () => ({
  prisma: {
    localConfig: {
      findUnique: findUniqueMock,
    },
  },
}))

mock.module('../lib/cloud-urls', () => ({
  getShogoCloudUrl: () => 'https://cloud.test',
}))

mock.module('../lib/federated-upstream', () => ({
  fetchUpstream: fetchUpstreamMock,
  getUpstreamCredential: mock(async () => 'shogo_sk_linked'),
  getUpstreamWorkspaceId: mock(async () => 'cloud-ws-1'),
}))

mock.module('../lib/cloud-key-state', () => ({
  markCloudKeyRejectedIfConfirmed: markIfConfirmedMock,
}))

const { localCloudBillingRoutes } = await import('../routes/local-cloud-billing')

function mountApp() {
  const app = new Hono()
  app.route('/api', localCloudBillingRoutes())
  return app
}

beforeEach(() => {
  findUniqueMock.mockReset()
  findUniqueMock.mockImplementation(async () => ({
    value: JSON.stringify({
      workspace: { id: 'cloud-ws-1', name: 'Cloud Workspace', slug: 'cloud-workspace' },
      user: { email: 'cloud@example.com' },
    }),
  }))
  fetchUpstreamMock.mockReset()
  fetchUpstreamMock.mockImplementation(async () => new Response('{}', { status: 200 }))
  markIfConfirmedMock.mockReset()
  markIfConfirmedMock.mockImplementation(async () => true)
})

describe('GET /local/cloud-billing/summary', () => {
  test('returns cloud workspace metadata, URLs, and plan data', async () => {
    fetchUpstreamMock.mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      planId: 'pro',
      paidTier: true,
      overageHardLimitUsd: 100,
    }), { status: 200 }))

    const response = await mountApp().request('/api/local/cloud-billing/summary')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      signedIn: true,
      cloudKeyRejected: false,
      email: 'cloud@example.com',
      workspace: {
        id: 'cloud-ws-1',
        name: 'Cloud Workspace',
        slug: 'cloud-workspace',
      },
      cloudUrl: 'https://cloud.test',
      manageUrl: 'https://cloud.test/settings?tab=billing&workspace=cloud-ws-1',
      upgradeUrl: 'https://cloud.test/billing?workspace=cloud-ws-1',
      plan: {
        ok: true,
        planId: 'pro',
        paidTier: true,
        overageHardLimitUsd: 100,
      },
    })
    expect(fetchUpstreamMock).toHaveBeenCalledWith(
      '/api/billing/workspace-plan',
      {
        method: 'GET',
        search: '?workspaceId=cloud-ws-1',
      },
    )
  })

  test('returns signedIn false when no cloud workspace is linked', async () => {
    const workspaceMock = (await import('../lib/federated-upstream')).getUpstreamWorkspaceId as any
    workspaceMock.mockImplementation(async () => null)

    const response = await mountApp().request('/api/local/cloud-billing/summary')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      signedIn: false,
      cloudUrl: 'https://cloud.test',
    })

    workspaceMock.mockImplementation(async () => 'cloud-ws-1')
  })

  test('marks the linked key rejected on upstream 401 once cloud confirms it', async () => {
    fetchUpstreamMock.mockImplementation(async () => new Response(
      JSON.stringify({ error: 'Key revoked' }),
      { status: 401 },
    ))

    const response = await mountApp().request('/api/local/cloud-billing/summary')
    expect(response.status).toBe(401)
    expect((await response.json() as any).cloudKeyRejected).toBe(true)
    expect(markIfConfirmedMock).toHaveBeenCalledWith('billing summary 401', 'shogo_sk_linked')
  })

  test('does not report the key rejected when cloud still says it is valid', async () => {
    fetchUpstreamMock.mockImplementation(async () => new Response('{}', { status: 401 }))
    markIfConfirmedMock.mockImplementation(async () => false)

    const response = await mountApp().request('/api/local/cloud-billing/summary')
    expect(response.status).toBe(401)
    expect((await response.json() as any).cloudKeyRejected).toBe(false)
  })
})

describe('POST /local/cloud-billing/usage-based-pricing', () => {
  test('injects the linked cloud workspace id before forwarding', async () => {
    fetchUpstreamMock.mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      overageEnabled: true,
      overageHardLimitUsd: 250,
    }), { status: 200 }))

    const response = await mountApp().request('/api/local/cloud-billing/usage-based-pricing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        overageEnabled: true,
        overageHardLimitUsd: 250,
        workspaceId: 'local-workspace-should-not-forward',
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      overageEnabled: true,
      overageHardLimitUsd: 250,
    })
    expect(fetchUpstreamMock).toHaveBeenCalledWith(
      '/api/billing/usage-based-pricing',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          overageEnabled: true,
          overageHardLimitUsd: 250,
          workspaceId: 'cloud-ws-1',
        }),
      }),
    )
  })
})
