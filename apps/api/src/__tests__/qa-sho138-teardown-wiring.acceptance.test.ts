// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-138 acceptance (QA, round 2): the teardown's PRODUCTION WIRING, not a
// test double.
//
// `teardownPublishedSite` takes a `deps` seam so the step list can be unit
// tested, and both other suites use it — which means nothing exercises
// `defaultDeps`. Every real step is reached through that object (and the
// runtime one through a lazy `import('../lib/substrate/router')`), and a wrong
// specifier there does not throw: the step is caught, reported as
// `{ok:false, error:'Cannot find module …'}` and the delete still succeeds, so
// the site would stay live while the logs said "teardown completed with 1
// failed step".
//
// This suite mocks only the modules the teardown calls — never `deps` — and
// asserts every published-site surface is really touched.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const PROJECT_ID = 'proj-138-wiring'
const SUBDOMAIN = 'wiring-site'

const calls: string[] = []

mock.module('../lib/prisma', () =>
  withPrismaExports({
    // `clearCustomDomainKv` short-circuits before it queries, so the custom-domain
    // KV step is asserted through `getCustomHostnamesConfig` returning null.
    prisma: { customDomain: { findMany: async () => [] } },
  }),
)

mock.module('../lib/cloudflare-site-auth-kv', () => ({
  clearSitePassword: async (subdomain: string) => {
    calls.push(`site-password:${subdomain}`)
  },
}))

mock.module('../lib/cloudflare-server-backed-kv', () => ({
  clearServerBackedFlag: async (subdomain: string) => {
    calls.push(`server-backed-flag:${subdomain}`)
  },
}))

mock.module('../lib/cloudflare-custom-hostnames', () => ({
  getCustomHostnamesConfig: () => null,
  deleteHostnameMapping: async (hostname: string) => {
    calls.push(`custom-domain:${hostname}`)
  },
}))

mock.module('../lib/publish-storage', () => ({
  deletePublishedStaticBundle: async (subdomain: string) => {
    calls.push(`static-bundle:${subdomain}`)
  },
  deletePublishedDataArchive: async (subdomain: string) => {
    calls.push(`published-data:${subdomain}`)
  },
}))

mock.module('../services/publish-git.service', () => ({
  deletePublishPointer: async (projectId: string, subdomain: string) => {
    calls.push(`publish-pointer:${projectId}:${subdomain}`)
  },
  flushGitSync: async () => null,
}))

mock.module('../lib/substrate/router', () => ({
  unpublishProjectEverywhere: async (projectId: string, subdomain: string) => {
    calls.push(`runtime:${projectId}:${subdomain}`)
  },
}))

const { teardownPublishedSite } = await import('../services/published-site-teardown')

beforeEach(() => {
  calls.length = 0
})

describe('teardownPublishedSite — production wiring', () => {
  test('a project delete reaches every surface, through the real defaults', async () => {
    const outcomes = await teardownPublishedSite(PROJECT_ID, SUBDOMAIN, {
      purgePublishedData: true,
      dropPublishPointer: false,
    })

    // Every step must have succeeded — `{ok:false}` here is the silent-leak path.
    expect(outcomes.filter((o) => !o.ok)).toEqual([])
    expect(calls).toEqual([
      `runtime:${PROJECT_ID}:${SUBDOMAIN}`,
      `static-bundle:${SUBDOMAIN}`,
      `published-data:${SUBDOMAIN}`,
      `site-password:${SUBDOMAIN}`,
      `server-backed-flag:${SUBDOMAIN}`,
      // No custom domains on this project: the config gate returns early.
    ])
    // The delete path deliberately does not resolve a pod URL for a gone row.
    expect(calls.some((c) => c.startsWith('publish-pointer:'))).toBe(false)
  })

  test('an unpublish keeps the data archive and drops the pointer', async () => {
    const outcomes = await teardownPublishedSite(PROJECT_ID, SUBDOMAIN, {
      purgePublishedData: false,
    })

    expect(outcomes.filter((o) => !o.ok)).toEqual([])
    expect(calls).toEqual([
      `runtime:${PROJECT_ID}:${SUBDOMAIN}`,
      `static-bundle:${SUBDOMAIN}`,
      `site-password:${SUBDOMAIN}`,
      `server-backed-flag:${SUBDOMAIN}`,
      `publish-pointer:${PROJECT_ID}:${SUBDOMAIN}`,
    ])
  })
})
