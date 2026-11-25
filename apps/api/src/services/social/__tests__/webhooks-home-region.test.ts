// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A Zernio event is applied only in its workspace's home region (SHO-585 §B).
 *
 * Any region can receive the webhook, and the inbox rows it writes are unique on
 * the provider's ids — so two regions importing the same comment collide and
 * poison logical replication (both regions imported the same Samsara Instagram
 * comments during the 2026-11-24 outage). A forwarded event is applied exactly
 * once, by the home region; an unreachable home region answers 503 so Zernio
 * retries, and nothing is written locally.
 *
 *   bun test apps/api/src/services/social/__tests__/webhooks-home-region.test.ts
 */

import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const EXTERNAL_ID = `ws_${WORKSPACE_ID}`

const profiles: Record<string, any> = {
  [EXTERNAL_ID]: {
    id: 'prof_1',
    workspaceId: WORKSPACE_ID,
    externalId: EXTERNAL_ID,
    localWorkspaceId: '',
    zernioProfileId: 'zp_1',
  },
}

mock.module('../../../lib/prisma', () => ({
  prisma: {
    socialProfile: { findUnique: async ({ where }: any) => profiles[where?.externalId] ?? null },
    socialAccount: { findUnique: async () => null, update: async () => null },
  },
}))

/** The local apply is replaced so "applied here" is observable. */
const appliedLocally: any[] = []
mock.module('../inbox.service', () => ({
  ingestSocialEvent: async (input: any) => {
    appliedLocally.push(input)
    return { handled: true }
  },
  SOCIAL_INBOX_FORWARD_PATH: '/api/internal/social/inbox',
}))
mock.module('../../workspace-events', () => ({ emitWorkspaceEvent: async () => null }))

type Outcome = 'local' | 'forwarded' | 'unavailable'
let outcome: Outcome = 'forwarded'
const routed: Array<{ workspaceId: string; path: string; body: any }> = []
mock.module('../../../lib/home-region-route', () => ({
  routeToHomeRegion: async (workspaceId: string, path: string, body: any) => {
    routed.push({ workspaceId, path, body })
    if (outcome === 'local') return { outcome: 'local' }
    if (outcome === 'forwarded') return { outcome: 'forwarded', data: { status: 200, body: { ok: true, inbox: { handled: true } } } }
    return { outcome: 'unavailable' }
  },
}))

const { handleZernioWebhook, SOCIAL_APPLY_PATH } = await import('../webhooks')

const SECRET = 'whsec_test'
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex')

const commentBody = JSON.stringify({
  id: 'evt_1',
  type: 'comment.received',
  profiles: [{ id: 'zp_1', externalId: EXTERNAL_ID }],
  account: { id: 'z_ig', platform: 'Instagram', username: 'acme.ig' },
  post: { id: 'zpost_1', platformPostId: 'ig_media_1' },
  comment: { id: 'zcmt_1', text: 'MERGE', createdTime: '2026-11-24T19:15:00.000Z' },
})

beforeEach(() => {
  outcome = 'forwarded'
  routed.length = 0
  appliedLocally.length = 0
})

describe('the Zernio webhook applies an event in the home region', () => {
  test('forwards a cloud-scoped event to /api/internal/social/apply', async () => {
    const res = await handleZernioWebhook({ rawBody: commentBody, signature: sign(commentBody), secret: SECRET })

    // The home region's own verdict is what Zernio sees, not a local guess.
    expect(res.status).toBe(200)
    expect(routed).toHaveLength(1)
    expect(routed[0].workspaceId).toBe(WORKSPACE_ID)
    expect(routed[0].path).toBe(SOCIAL_APPLY_PATH)
    expect(routed[0].body).toMatchObject({
      workspaceId: WORKSPACE_ID,
      externalId: EXTERNAL_ID,
      type: 'comment.received',
    })
    expect(routed[0].body.comment).toBeUndefined() // the event rides in `detail`/`payload`, not re-derived
    expect(appliedLocally).toHaveLength(0)
  })

  test('answers 503 (and writes nothing) when the home region is unreachable', async () => {
    outcome = 'unavailable'
    const res = await handleZernioWebhook({ rawBody: commentBody, signature: sign(commentBody), secret: SECRET })

    expect(res.status).toBe(503)
    expect((res.body as any).error.code).toBe('home_region_unavailable')
    expect(appliedLocally).toHaveLength(0)
  })

  test('applies here when this region is the home region', async () => {
    outcome = 'local'
    await handleZernioWebhook({ rawBody: commentBody, signature: sign(commentBody), secret: SECRET })
    // Routed, and the local apply ran — the rest of `applySocialEvent` is the
    // pre-existing cloud path this card does not touch.
    expect(routed).toHaveLength(1)
    expect(appliedLocally).toHaveLength(1)
    expect(appliedLocally[0]).toMatchObject({ workspaceId: WORKSPACE_ID, type: 'comment.received' })
  })

  test('a bad signature never reaches the router', async () => {
    const res = await handleZernioWebhook({ rawBody: commentBody, signature: 'nope', secret: SECRET })
    expect(res.status).toBe(401)
    expect(routed).toHaveLength(0)
  })
})
