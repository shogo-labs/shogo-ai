// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Custom domains on an unpublished project (SHO-304, QA round 1 blocker 2).
 *
 * The Worker KV `hostname -> subdomain` map is written from
 * `publishedSubdomain`, so a domain attached to a project that isn't published
 * could never serve. Every mutating handler therefore refuses with
 * `not_published` — on cloud as well as on desktop, which is what AC6 asks for.
 *
 * `list` deliberately stays open (it reports `published: false`) and `delete`
 * stays open too: domain rows survive an unpublish so a republish restores
 * routing, and removing one is the only way to free the hostname again.
 *
 * No Cloudflare call is made — `cloudflare-custom-hostnames` is mocked.
 *
 * Run: bun --smol test apps/api/src/__tests__/custom-domains-not-published.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = {
  project: null as any,
  cfConfigured: true,
  rows: [] as any[],
  createdHostnames: [] as string[],
  deletedHostnames: [] as string[],
}

mock.module('../lib/prisma', () => ({
  prisma: {
    project: { findUnique: async () => store.project },
    customDomain: {
      findMany: async () => store.rows,
      findUnique: async ({ where }: any) => store.rows.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `row-${store.rows.length + 1}`, ...data }
        store.rows.push(row)
        return row
      },
      update: async ({ where, data }: any) => {
        const row = store.rows.find((r) => r.id === where.id)
        if (row) Object.assign(row, data)
        return row
      },
      updateMany: async () => ({ count: 0 }),
      deleteMany: async ({ where }: any) => {
        const ids: string[] = where.id.in
        store.rows = store.rows.filter((r) => !ids.includes(r.id))
        return { count: ids.length }
      },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  },
}))

const realCloudflare = await import('../lib/cloudflare-custom-hostnames')

mock.module('../lib/cloudflare-custom-hostnames', () => ({
  ...realCloudflare,
  getCustomHostnamesConfig: () =>
    store.cfConfigured ? { fallbackOrigin: 'fallback.shogo.one' } : null,
  createCustomHostname: async (hostname: string) => {
    store.createdHostnames.push(hostname)
    return { id: `cf-${hostname}`, sslStatus: 'pending_validation', errors: [] }
  },
  deleteCustomHostname: async (id: string) => {
    store.deletedHostnames.push(id)
  },
  retriggerCustomHostname: async () => {},
  putHostnameMapping: async () => {},
  deleteHostnameMapping: async () => {},
}))

const {
  addCustomDomain,
  listCustomDomains,
  verifyCustomDomain,
  retriggerCustomDomain,
  setPrimaryCustomDomain,
  deleteCustomDomain,
} = await import('../routes/publish')

const PROJECT_ID = 'proj-unpublished'

beforeEach(() => {
  store.project = { publishedSubdomain: null }
  store.cfConfigured = true
  store.rows = []
  store.createdHostnames = []
  store.deletedHostnames = []
})

describe('custom domains on an unpublished project', () => {
  test('add refuses with not_published and never registers a Cloudflare hostname', async () => {
    const res = await addCustomDomain(PROJECT_ID, 'example.com')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('not_published')
    expect(res.body.error.message).toContain('Publish this project first')
    expect(store.createdHostnames).toEqual([])
    expect(store.rows).toEqual([])
  })

  test('verify / retrigger / make_primary all refuse with not_published', async () => {
    store.rows = [{ id: 'd1', projectId: PROJECT_ID, hostname: 'example.com', status: 'pending' }]

    for (const res of [
      await verifyCustomDomain(PROJECT_ID, 'd1'),
      await retriggerCustomDomain(PROJECT_ID, 'd1'),
      await setPrimaryCustomDomain(PROJECT_ID, 'd1'),
    ]) {
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('not_published')
    }
  })

  test('list still reports the attached domains, flagged published: false', async () => {
    store.rows = [{ id: 'd1', projectId: PROJECT_ID, hostname: 'example.com', status: 'pending' }]
    const res = await listCustomDomains(PROJECT_ID)
    expect(res.status).toBe(200)
    expect(res.body.published).toBe(false)
    expect(res.body.enabled).toBe(true)
    expect(res.body.domains).toHaveLength(1)
  })

  test('remove still works, so a hostname can be freed while the site is down', async () => {
    store.rows = [{ id: 'd1', projectId: PROJECT_ID, hostname: 'example.com', status: 'pending', cfCustomHostnameId: 'cf-1' }]
    const res = await deleteCustomDomain(PROJECT_ID, 'd1')
    expect(res.status).toBe(200)
    expect(res.body.removedIds).toEqual(['d1'])
    expect(store.deletedHostnames).toEqual(['cf-1'])
  })

  test('a missing project is project_not_found, not not_published', async () => {
    store.project = null
    const res = await addCustomDomain(PROJECT_ID, 'example.com')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('project_not_found')
  })
})

describe('custom domains on a published project', () => {
  beforeEach(() => {
    store.project = { publishedSubdomain: 'my-app' }
  })

  test('add registers the apex + www pair and returns the CNAME target', async () => {
    const res = await addCustomDomain(PROJECT_ID, 'example.com')
    expect(res.status).toBe(201)
    expect(res.body.fallbackOrigin).toBe('fallback.shogo.one')
    expect(store.createdHostnames).toEqual(['example.com', 'www.example.com'])
    expect(res.body.domains.map((d: any) => d.hostname).sort()).toEqual([
      'example.com',
      'www.example.com',
    ])
  })

  test('list reports published: true', async () => {
    const res = await listCustomDomains(PROJECT_ID)
    expect(res.body.published).toBe(true)
  })

  test('Cloudflare not configured is not_enabled, not not_published', async () => {
    store.cfConfigured = false
    const res = await addCustomDomain(PROJECT_ID, 'example.com')
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('not_enabled')
  })
})
