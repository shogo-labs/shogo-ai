// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const projects: Record<string, { publishedSubdomain: string | null; workspace: { homeRegion: string | null } }> = {
  p_us: { publishedSubdomain: 'us-site', workspace: { homeRegion: 'us-ashburn-1' } },
  p_eu: { publishedSubdomain: 'eu-site', workspace: { homeRegion: 'eu-frankfurt-1' } },
  p_legacy: { publishedSubdomain: 'old-site', workspace: { homeRegion: null } },
}

mock.module('../prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => projects[id] ?? null,
    },
  },
}))

mock.module('../region', () => ({
  RAW_REGION_ID: 'eu-frankfurt-1',
  REGION_PEERS: [{ id: 'us-ashburn-1', label: 'US', url: 'https://us.example' }],
  getPeer: () => undefined,
}))

const peerCalls: Array<{ region: string; path: string; body: any }> = []
let peerReply: { status: number; ok: boolean; data: unknown } | Error = { status: 202, ok: true, data: {} }
mock.module('../region-peer-proxy', () => ({
  callPeerInternal: async (region: string, path: string, body: unknown) => {
    peerCalls.push({ region, path, body })
    if (peerReply instanceof Error) throw peerReply
    return peerReply
  },
}))

const { askPeersToReleasePublished, releasePublishedForPeer, PUBLISHED_RELEASE_PATH, _resetPublishedReleaseAsks } =
  await import('../published-home-region')

beforeEach(() => {
  peerCalls.length = 0
  peerReply = { status: 202, ok: true, data: {} }
  _resetPublishedReleaseAsks()
})

describe('askPeersToReleasePublished', () => {
  test('asks every peer to release the site', async () => {
    await askPeersToReleasePublished('p_eu', 'eu-site', 1_000)
    expect(peerCalls).toEqual([
      { region: 'us-ashburn-1', path: PUBLISHED_RELEASE_PATH, body: { projectId: 'p_eu', subdomain: 'eu-site' } },
    ])
  })

  test('asks at most once per interval per site', async () => {
    await askPeersToReleasePublished('p_eu', 'eu-site', 1_000)
    await askPeersToReleasePublished('p_eu', 'eu-site', 2_000)
    await askPeersToReleasePublished('p_other', 'other', 2_000)
    await askPeersToReleasePublished('p_eu', 'eu-site', 1_000 + 10 * 60_000)
    expect(peerCalls.map((c) => c.body.projectId)).toEqual(['p_eu', 'p_other', 'p_eu'])
  })

  test('a peer that is down does not throw', async () => {
    peerReply = new Error('connect timeout')
    await expect(askPeersToReleasePublished('p_eu', 'eu-site', 1_000)).resolves.toBeUndefined()
  })
})

describe('releasePublishedForPeer', () => {
  function recorder() {
    const calls: unknown[][] = []
    return { calls, release: async (...args: unknown[]) => void calls.push(args) }
  }

  test('releases a site whose home is another region', async () => {
    const { calls, release } = recorder()
    const r = await releasePublishedForPeer({ projectId: 'p_us', subdomain: 'us-site' }, release)
    expect(r.status).toBe(202)
    expect(calls).toEqual([['p_us', 'us-site', 'us-ashburn-1']])
  })

  test('never releases a site this region is home for', async () => {
    const { calls, release } = recorder()
    const r = await releasePublishedForPeer({ projectId: 'p_eu', subdomain: 'eu-site' }, release)
    expect(r.status).toBe(409)
    expect(calls).toHaveLength(0)
  })

  test('leaves sites with an unknown home region alone', async () => {
    const { calls, release } = recorder()
    expect((await releasePublishedForPeer({ projectId: 'p_legacy', subdomain: 'old-site' }, release)).status).toBe(409)
    expect(calls).toHaveLength(0)
  })

  test('rejects a subdomain that is not the project’s and malformed bodies', async () => {
    const { calls, release } = recorder()
    expect((await releasePublishedForPeer({ projectId: 'p_us', subdomain: 'eu-site' }, release)).status).toBe(404)
    expect((await releasePublishedForPeer({ projectId: 'missing', subdomain: 'x' }, release)).status).toBe(404)
    expect((await releasePublishedForPeer({ projectId: 'p_us' }, release)).status).toBe(400)
    expect((await releasePublishedForPeer(null, release)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
