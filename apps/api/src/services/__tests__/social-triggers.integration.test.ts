// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P3 — `social.*` in the trigger surface.
 *
 * A social trigger is only useful with an account connected, and "no accounts
 * yet" is exactly what `trigger_types_list` has to be able to say, so both the
 * catalog and the refusal are tested against a real DB.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const {
  createSubscription,
  listTriggerTypes,
  socialTriggerTypes,
  validateEventType,
} = await import('../event-subscription.service')

const db = prisma as any

const suffix = crypto.randomUUID().slice(0, 8)
let workspaceId = ''

beforeAll(async () => {
  const ws = await db.workspace.create({
    data: { name: 'Triggers', slug: `triggers-${suffix}`, kind: 'team' },
  })
  workspaceId = ws.id
  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      zernioProfileId: `zp_${suffix}`,
      externalId: `ws_${workspaceId}`,
      name: 'Triggers',
    },
  })
  await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `acc_${suffix}`,
      platform: 'instagram',
      username: 'triggers.ig',
    },
  })
})

describe('social event types', () => {
  test('a social event is accepted and sourced from Zernio', () => {
    expect(validateEventType('social.comment.received')).toEqual({
      eventType: 'social.comment.received',
      source: 'zernio',
    })
    expect(validateEventType('social.*')).toEqual({ eventType: 'social.*', source: 'zernio' })
  })

  test('a social-looking type that does not exist is refused', () => {
    expect(() => validateEventType('social.comment.exploded')).toThrow(/not a social event/)
  })
})

describe('the trigger catalog', () => {
  test('lists the workspace’s accounts and every social event', async () => {
    const social = await socialTriggerTypes(workspaceId)
    expect(social.connected).toBe(true)
    expect(social.accounts).toEqual([{ id: expect.any(String), platform: 'instagram', username: 'triggers.ig' }])
    expect(social.events.map((e: any) => e.type).sort()).toEqual([
      'social.account.connected',
      'social.account.disconnected',
      'social.automation.run.completed',
      'social.automation.run.failed',
      'social.comment.received',
      'social.message.received',
      'social.message.sent',
    ])
  })

  test('trigger_types_list carries the social block and the event definitions', async () => {
    const types = await listTriggerTypes(workspaceId, 'user_test')
    expect(types.social.connected).toBe(true)
    expect(types.native.some((def: any) => def.type === 'social.comment.received')).toBe(true)
  })

  test('a social trigger is refused while nothing is connected', async () => {
    const empty = await db.workspace.create({
      data: { name: 'Nothing', slug: `nothing-${suffix}`, kind: 'team' },
    })
    const error = await createSubscription({
      workspaceId: empty.id,
      name: 'On a comment',
      eventType: 'social.comment.received',
      prompt: 'Reply to the comment',
    }).catch((err: any) => err)
    expect(error.status).toBe(412)
    expect(error.code).toBe('social_not_connected')
  })

  test('with an account connected the trigger is created as a Zernio-sourced one', async () => {
    const created = await createSubscription({
      workspaceId,
      name: 'On a comment',
      eventType: 'social.comment.received',
      prompt: 'Reply to the comment',
    })
    expect(created.subscription.eventType).toBe('social.comment.received')
    expect(created.subscription.source).toBe('zernio')
  })
})
