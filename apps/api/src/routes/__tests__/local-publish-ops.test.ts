// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-308 §5: the `ops_action` half of the agent's `publish` tool on DESKTOP.
//
// `local-route-parity.test.ts` only proves the route exists. This asserts what
// it answers: `status`/`list` report the one published copy from the local
// publish row, and every action that needs replicas, revisions, environments,
// logs, metrics or cost says `cloud_only` (409) with a message the agent can
// act on — never a bare 404, which is what the tool originally got.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

type Row = Record<string, any>

let projectRow: Row | null = null
let authorized = true

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ select }: any) => {
        if (!projectRow) return null
        if (!select) return { ...projectRow }
        const picked: Row = {}
        for (const key of Object.keys(select)) picked[key] = projectRow[key] ?? null
        return picked
      },
    },
    localConfig: {
      findUnique: async () => null,
    },
  },
}))

mock.module('../internal-runtime-auth', () => ({
  authenticateRuntimeToken: async () => (authorized ? { projectId: 'p1' } : null),
}))

mock.module('../../lib/federated-upstream', () => ({
  getUpstreamCredential: async () => null,
}))

const { localPublishRoutes } = await import('../local-publish')

const ops = (body: unknown) =>
  localPublishRoutes().request('/internal/projects/p1/publish/ops', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  authorized = true
  projectRow = {
    id: 'p1',
    publishedSubdomain: 'shogo-guides',
    publishedAt: new Date('2026-11-01T10:00:00.000Z'),
    accessLevel: 'anyone',
    sitePasswordHash: null,
    siteTitle: null,
    siteDescription: null,
    publishStatus: 'live',
    publishError: null,
  }
  process.env.PUBLISH_DOMAIN = 'shogo.one'
})

describe('local publish ops — status and list', () => {
  it('reports the single published copy from the local publish row', async () => {
    const res = await ops({ action: 'status' })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.substrate).toBe('local')
    expect(body.environment.name).toBe('production')
    expect(body.environment.subdomain).toBe('shogo-guides')
    expect(body.environment.url).toBe('https://shogo-guides.shogo.one')
    expect(body.environment.publishStatus).toBe('live')
    expect(body.replicas).toEqual({ ready: 1, total: 1, desired: 1 })
    expect(body.revision).toBeNull()
    expect(body.pods).toEqual([])
  })

  it('list returns the same one environment', async () => {
    const body = await (await ops({ action: 'list' })).json()
    expect(body.environments).toHaveLength(1)
    expect(body.environments[0].name).toBe('production')
  })

  it('an unpublished project reports zero replicas and no url', async () => {
    projectRow!.publishedSubdomain = null
    projectRow!.publishStatus = 'idle'
    const body = await (await ops({ action: 'status' })).json()
    expect(body.environment.subdomain).toBeNull()
    expect(body.environment.url).toBeNull()
    expect(body.replicas).toEqual({ ready: 0, total: 0, desired: null })
  })
})

describe('local publish ops — actions desktop cannot do', () => {
  for (const action of [
    'metrics',
    'logs',
    'scale',
    'rollback',
    'redeploy',
    'promote',
    'create_env',
    'delete_env',
  ]) {
    it(`${action} returns cloud_only, not 404`, async () => {
      const res = await ops({ action })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error.code).toBe('cloud_only')
      expect(body.error.message).toContain('Nothing was changed')
    })
  }

  it('a staging status is cloud_only — staging only exists on Knative', async () => {
    const res = await ops({ action: 'status', environment: 'staging' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('cloud_only')
  })

  it('an unknown action is cloud_only rather than a silent success', async () => {
    const res = await ops({ action: 'explode' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('cloud_only')
  })
})

describe('local publish ops — auth and bad input', () => {
  it('rejects a request without a runtime token', async () => {
    authorized = false
    const res = await ops({ action: 'status' })
    expect(res.status).toBe(401)
  })

  it('rejects a body that is not JSON', async () => {
    const res = await localPublishRoutes().request('/internal/projects/p1/publish/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_body')
  })
})
