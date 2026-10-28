// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-138: deleting a project must take its published site down. The unpublish
// route and the project-delete hook share ONE teardown, so these tests pin the
// shared contract: what steps run, in what order, which are optional, and that
// one failing step never stops the rest (a best-effort teardown must still try
// everything, or a single flaky KV call leaves a site serving).

import { describe, expect, test } from 'bun:test'
import { teardownPublishedSite, type PublishedSiteTeardownDeps } from '../published-site-teardown'

function recordingDeps(overrides: Partial<PublishedSiteTeardownDeps> = {}) {
  const calls: string[] = []
  const track = (name: string) => async () => {
    calls.push(name)
  }
  const deps: Partial<PublishedSiteTeardownDeps> = {
    unpublishRuntime: async (projectId, subdomain) => {
      calls.push(`runtime:${projectId}:${subdomain}`)
    },
    deleteStaticBundle: async (subdomain) => {
      calls.push(`static-bundle:${subdomain}`)
    },
    deleteDataArchive: async (subdomain) => {
      calls.push(`published-data:${subdomain}`)
    },
    clearSitePassword: track('site-password'),
    clearServerBackedFlag: track('server-backed-flag'),
    clearCustomDomains: track('custom-domains'),
    deletePublishPointer: track('publish-pointer'),
    ...overrides,
  }
  return { calls, deps }
}

describe('teardownPublishedSite', () => {
  test('unpublish tears down every published-site surface but keeps the data archive', async () => {
    const { calls, deps } = recordingDeps()

    const outcomes = await teardownPublishedSite('proj-1', 'my-site', { deps })

    expect(outcomes.every((o) => o.ok)).toBe(true)
    expect(outcomes.map((o) => o.step)).toEqual([
      'runtime',
      'static-bundle',
      'site-password',
      'server-backed-flag',
      'custom-domains',
      'publish-pointer',
    ])
    // The published-data archive is what a republish restores end-user writes
    // from — unpublish must not delete it.
    expect(calls).toEqual([
      'runtime:proj-1:my-site',
      'static-bundle:my-site',
      'site-password',
      'server-backed-flag',
      'custom-domains',
      'publish-pointer',
    ])
  })

  test('project delete purges the published-data archive too', async () => {
    const { calls, deps } = recordingDeps()

    const outcomes = await teardownPublishedSite('proj-2', 'my-site', {
      purgePublishedData: true,
      deps,
    })

    expect(outcomes.map((o) => o.step)).toContain('published-data')
    expect(calls).toContain('published-data:my-site')
    // Order matters: the bundle goes before the archive (same bucket prefix
    // family, and a failed archive purge must not skip the bundle).
    expect(calls.indexOf('static-bundle:my-site')).toBeLessThan(
      calls.indexOf('published-data:my-site'),
    )
  })

  test('a failing step does not stop the rest, and is reported not thrown', async () => {
    const { calls, deps } = recordingDeps({
      deleteStaticBundle: async () => {
        throw new Error('S3 blew up')
      },
    })

    const outcomes = await teardownPublishedSite('proj-3', 'my-site', { deps })

    const staticBundle = outcomes.find((o) => o.step === 'static-bundle')
    expect(staticBundle).toEqual({ step: 'static-bundle', ok: false, error: 'S3 blew up' })
    // Everything after the failure still ran.
    expect(calls).toContain('site-password')
    expect(calls).toContain('publish-pointer')
    expect(outcomes.filter((o) => o.ok).length).toBe(outcomes.length - 1)
  })

  test('delete skips the publish pointer, because resolving the pod would cold-start a runtime', async () => {
    const { calls, deps } = recordingDeps()

    const outcomes = await teardownPublishedSite('proj-5', 'my-site', {
      purgePublishedData: true,
      dropPublishPointer: false,
      deps,
    })

    expect(outcomes.map((o) => o.step)).not.toContain('publish-pointer')
    expect(calls).not.toContain('publish-pointer')
  })

  test('never throws, even when every step fails', async () => {
    const boom = async () => {
      throw new Error('nope')
    }
    const deps: Partial<PublishedSiteTeardownDeps> = {
      unpublishRuntime: boom,
      deleteStaticBundle: boom,
      deleteDataArchive: boom,
      clearSitePassword: boom,
      clearServerBackedFlag: boom,
      clearCustomDomains: boom,
      deletePublishPointer: boom,
    }

    const outcomes = await teardownPublishedSite('proj-4', 'my-site', {
      purgePublishedData: true,
      deps,
    })

    expect(outcomes).toHaveLength(7)
    expect(outcomes.every((o) => !o.ok)).toBe(true)
  })
})
