// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb, seedWorkspace, type SeededWorkspace } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET = 'event-identity-test'

const { prisma } = await import('../../lib/prisma')
const { verifyRequesterTicket } = await import('../../lib/requester-ticket')
const {
  actorFromPayload,
  eventRequesterTicket,
  isValidActorPath,
  readPath,
  resolveEventPerson,
  suggestActorFields,
} = await import('../event-identity')
const { findLinkedMember, findMemberByEmail, identityFromWhoAmI, linkIdentity, pickWhoAmITool } = await import('../identity-links')

const db = prisma as any
let seeded: SeededWorkspace

beforeAll(async () => {
  seeded = await seedWorkspace(db)
})

describe('reading the actor out of a payload', () => {
  test('dot and index paths', () => {
    const payload = { issue: { reporter: { accountId: 'a-1' } }, assignees: [{ id: 7 }] }
    expect(readPath(payload, 'issue.reporter.accountId')).toBe('a-1')
    expect(readPath(payload, 'assignees[0].id')).toBe(7)
    expect(readPath(payload, 'issue.missing.id')).toBeUndefined()
    expect(isValidActorPath('sender.id')).toBe(true)
    expect(isValidActorPath('a[0].b')).toBe(true)
    expect(isValidActorPath('__proto__..x')).toBe(false)
    expect(isValidActorPath('a; drop')).toBe(false)
  })

  test('ids and emails become a platform actor; nothing usable gives none', () => {
    const payload = { user: { id: 42, email: 'Ada@Example.com' } }
    expect(actorFromPayload(payload, { source: 'composio:linear', idPath: 'user.id', emailPath: 'user.email' }))
      .toEqual({ source: 'composio:linear', externalId: '42', email: 'ada@example.com', trust: 'platform' })
    expect(actorFromPayload(payload, { source: 'x', emailPath: 'user.id' })).toBeNull()
    expect(actorFromPayload({ user: { id: {} } }, { source: 'x', idPath: 'user.id' })).toBeNull()
    expect(actorFromPayload(payload, { source: 'x' })).toBeNull()
  })

  test('suggestions come from the schema, people-shaped fields first', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        user_id: { type: 'string' },
        sender: { type: 'object', properties: { id: { type: 'number' }, login: { type: 'string' } } },
        repository: { type: 'object', properties: { id: { type: 'number' }, owner: { type: 'object', properties: { id: { type: 'number' } } } } },
        commit: { type: 'object', properties: { author: { type: 'object', properties: { email: { type: 'string' } } } } },
      },
    }
    const { idPaths, emailPaths } = suggestActorFields(schema)
    expect(idPaths[0]).toBe('user_id')
    expect(idPaths).toContain('sender.id')
    expect(idPaths).toContain('repository.owner.id')
    expect(idPaths.indexOf('sender.id')).toBeLessThan(idPaths.indexOf('sender.login'))
    expect(idPaths).not.toContain('id')
    expect(idPaths).not.toContain('repository.id')
    expect(emailPaths).toEqual(['commit.author.email'])
    expect(suggestActorFields(null)).toEqual({ idPaths: [], emailPaths: [] })
  })
})

describe('Composio who-am-I', () => {
  test('picks a no-argument "current user" action by name', () => {
    expect(pickWhoAmITool([
      { slug: 'JIRA_GET_USER', input_parameters: { required: ['accountId'] } },
      { slug: 'JIRA_GET_CURRENT_USER', input_parameters: { required: [] } },
    ])).toBe('JIRA_GET_CURRENT_USER')
    expect(pickWhoAmITool([{ slug: 'SLACK_AUTH_TEST' }])).toBe('SLACK_AUTH_TEST')
    expect(pickWhoAmITool([{ slug: 'GITHUB_GET_THE_AUTHENTICATED_USER' }])).toBe('GITHUB_GET_THE_AUTHENTICATED_USER')
    expect(pickWhoAmITool([{ slug: 'NOTION_GET_ABOUT_ME', inputParameters: { required: ['x'] } }])).toBeNull()
    expect(pickWhoAmITool([{ slug: 'TRELLO_GET_MEMBER' }])).toBeNull()
  })

  test('finds the id and email in common response shapes', () => {
    expect(identityFromWhoAmI({ successful: true, data: { accountId: 'j-1', emailAddress: 'a@b.co' } }))
      .toEqual({ externalId: 'j-1', email: 'a@b.co' })
    expect(identityFromWhoAmI({ data: { ok: true, user_id: 'U1', team_id: 'T1', user: 'ada' } }))
      .toEqual({ externalId: 'U1', email: null })
    expect(identityFromWhoAmI({ data: { viewer: { id: 'lin-1', email: 'v@x.io' } } }))
      .toEqual({ externalId: 'lin-1', email: 'v@x.io' })
    expect(identityFromWhoAmI({ data: { response_data: { id: 9, login: 'gh' } } }))
      .toEqual({ externalId: '9', email: null })
    expect(identityFromWhoAmI({ id: 'top-level-ids-are-not-the-user' })).toBeNull()
    expect(identityFromWhoAmI({ data: {} })).toBeNull()
  })
})

describe('who an event turn acts as', () => {
  const base = () => ({ workspaceId: seeded.workspaceId, ownerUserId: seeded.owner })

  test('subscriber is the owner while they are a member; nobody is nobody', async () => {
    expect(await resolveEventPerson({ ...base() })).toEqual({ userId: seeded.owner, match: 'subscriber' })
    expect(await resolveEventPerson({ ...base(), ownerUserId: seeded.outsider })).toBeNull()
    expect(await resolveEventPerson({ ...base(), actsAs: 'nobody' })).toBeNull()
  })

  test('a Shogo actor is taken at its word; a claimed one never is', async () => {
    const shogo = { source: 'shogo', externalId: seeded.member, trust: 'platform' as const }
    expect(await resolveEventPerson({ ...base(), actsAs: 'actor', actor: shogo })).toEqual({ userId: seeded.member, match: 'platform_id' })
    expect(await resolveEventPerson({ ...base(), actsAs: 'actor', actor: { ...shogo, trust: 'claimed' } })).toBeNull()
    expect(await resolveEventPerson({ ...base(), actsAs: 'actor', actor: { ...shogo, externalId: seeded.outsider } })).toBeNull()
    expect(await resolveEventPerson({ ...base(), actsAs: 'actor', actor: null })).toBeNull()
  })

  test('platform ids go through links and sign-in accounts, members only, exactly one', async () => {
    await linkIdentity({ userId: seeded.member, source: 'composio:linear', externalId: 'lin-m' })
    await linkIdentity({ userId: seeded.outsider, source: 'composio:linear', externalId: 'lin-o' })
    await db.account.create({ data: { userId: seeded.member, providerId: 'github', accountId: '5150' } })
    expect(await findLinkedMember(seeded.workspaceId, 'composio:linear', 'lin-m')).toBe(seeded.member)
    expect(await findLinkedMember(seeded.workspaceId, 'composio:linear', 'lin-o')).toBeNull()
    expect(await findLinkedMember(seeded.workspaceId, 'composio:jira', 'lin-m')).toBeNull()
    expect(await findLinkedMember(seeded.workspaceId, 'github', '5150')).toBe(seeded.member)

    // Re-linking replaces the user's older account on that platform.
    await linkIdentity({ userId: seeded.member, source: 'composio:linear', externalId: 'lin-m2' })
    expect(await findLinkedMember(seeded.workspaceId, 'composio:linear', 'lin-m')).toBeNull()
    expect(await findLinkedMember(seeded.workspaceId, 'composio:linear', 'lin-m2')).toBe(seeded.member)
  })

  test('emails only with trustActorEmail, verified Shogo emails or linked ones', async () => {
    await db.user.update({ where: { id: seeded.viewer }, data: { email: 'viewer-verified@acme.test', emailVerified: true } })
    const actor = { source: 'composio:zendesk', email: 'viewer-verified@acme.test', trust: 'platform' as const }
    expect(await resolveEventPerson({ ...base(), actsAs: 'actor', actor })).toBeNull()
    expect(await resolveEventPerson({ ...base(), actsAs: 'actor', actor, trustActorEmail: true }))
      .toEqual({ userId: seeded.viewer, match: 'platform_email' })
    // An unverified Shogo email doesn't count.
    const owner = await db.user.findUnique({ where: { id: seeded.owner } })
    expect(await findMemberByEmail(seeded.workspaceId, owner.email)).toBeNull()
    await linkIdentity({ userId: seeded.owner, source: 'composio:zendesk', externalId: 'z-1', email: 'Owner@Elsewhere.test' })
    expect(await findMemberByEmail(seeded.workspaceId, 'owner@elsewhere.test')).toBe(seeded.owner)
  })

  test('the ticket names the event and how the person was chosen', () => {
    const ticket = eventRequesterTicket(seeded.projectId, { userId: seeded.member, match: 'platform_id' }, {
      id: 'evt-1', subscriptionId: 'sub-1', source: 'composio:linear',
    })
    expect(verifyRequesterTicket(ticket, seeded.projectId)).toMatchObject({
      userId: seeded.member,
      origin: { kind: 'event', eventId: 'evt-1', subscriptionId: 'sub-1', source: 'composio:linear', match: 'platform_id' },
    })
    expect(eventRequesterTicket(seeded.projectId, null, { id: 'evt-1', source: 'shogo' })).toBeUndefined()
  })
})
