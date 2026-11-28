// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Route tests for the onboarding endpoints in `routes/local-user.ts`:
 * `POST /onboarding/complete` (optional intent) and `GET /me/getting-started`.
 *
 *   bun test apps/api/src/routes/__tests__/local-user-onboarding.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

const s = {
  userUpdates: [] as any[],
  user: null as any,
  ownedTeamMembers: [] as Array<{ workspaceId: string | null }>,
  chatMessage: null as any,
  chatMessageQueries: [] as any[],
  project: null as any,
  install: null as any,
  slackInstall: null as any,
  slackLink: null as any,
  otherMember: null as any,
  invitation: null as any,
}

mock.module('../../lib/prisma', () => withPrismaExports({
  prisma: {
    user: {
      findUnique: async (args: any) => s.user,
      update: async (args: any) => {
        s.userUpdates.push(args)
        return { id: args.where.id, ...args.data }
      },
    },
    member: {
      findMany: async () => s.ownedTeamMembers,
      findFirst: async () => s.otherMember,
    },
    chatMessage: {
      findFirst: async (args: any) => {
        s.chatMessageQueries.push(args)
        return s.chatMessage
      },
    },
    project: { findFirst: async () => s.project },
    marketplaceInstall: { findFirst: async () => s.install },
    slackWorkspaceInstallation: { findFirst: async () => s.slackInstall },
    slackUserLink: { findFirst: async () => s.slackLink },
    invitation: { findFirst: async () => s.invitation },
  },
}))

const { userProfileRoutes } = await import('../local-user')

function makeApp(userId: string | null = 'u-1') {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth' as never, (userId ? { isAuthenticated: true, userId } : {}) as never)
    await next()
  })
  app.route('/api', userProfileRoutes())
  return app
}

beforeEach(() => {
  s.userUpdates = []
  s.user = null
  s.ownedTeamMembers = []
  s.chatMessage = null
  s.chatMessageQueries = []
  s.project = null
  s.install = null
  s.slackInstall = null
  s.slackLink = null
  s.otherMember = null
  s.invitation = null
})

describe('POST /api/onboarding/complete', () => {
  test('marks onboarding complete without a body (local wizard)', async () => {
    const res = await makeApp().request('/api/onboarding/complete', { method: 'POST' })
    expect(res.status).toBe(200)
    // SHO-614: the sign-up intent drives the FIRST onboarding only.
    expect(s.userUpdates[0].data).toEqual({ onboardingCompleted: true, signupIntent: null })
  })

  test('persists a valid intent', async () => {
    const res = await makeApp().request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'team' }),
    })
    expect(res.status).toBe(200)
    expect(s.userUpdates[0].data).toEqual({
      onboardingCompleted: true,
      signupIntent: null,
      onboardingIntent: 'team',
    })
  })

  test('rejects an unknown intent without writing', async () => {
    const res = await makeApp().request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'both' }),
    })
    expect(res.status).toBe(400)
    expect(s.userUpdates).toHaveLength(0)
  })

  test('401s when unauthenticated', async () => {
    const res = await makeApp(null).request('/api/onboarding/complete', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/onboarding/intent', () => {
  test('returns the stored sign-up intent', async () => {
    s.user = { signupIntent: JSON.stringify({ prompt: 'A booking page for my salon', plan: 'basic' }) }
    const res = await makeApp().request('/api/onboarding/intent')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      intent: { prompt: 'A booking page for my salon', plan: 'basic' },
    })
  })

  test('answers { intent: null } when the account has none', async () => {
    s.user = { signupIntent: null }
    const res = await makeApp().request('/api/onboarding/intent')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ intent: null })
  })

  test('answers { intent: null } for a value it cannot parse', async () => {
    s.user = { signupIntent: '{not json' }
    const res = await makeApp().request('/api/onboarding/intent')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ intent: null })
  })

  test('404s when the session user is gone', async () => {
    s.user = null
    const res = await makeApp().request('/api/onboarding/intent')
    expect(res.status).toBe(404)
  })

  test('401s when unauthenticated', async () => {
    const res = await makeApp(null).request('/api/onboarding/intent')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/me/getting-started', () => {
  test('reports everything false for a brand-new user', async () => {
    const res = await makeApp().request('/api/me/getting-started')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      sentFirstMessage: false,
      createdProject: false,
      installedAgent: false,
      connectedIntegration: false,
      invitedTeammate: false,
    })
  })

  test('reports each signal from its source', async () => {
    s.ownedTeamMembers = [{ workspaceId: 'ws-team' }]
    s.chatMessage = { id: 'msg' }
    s.project = { id: 'p' }
    s.install = { id: 'i' }
    s.slackLink = { id: 'l' }
    s.invitation = { id: 'inv' }
    const res = await makeApp().request('/api/me/getting-started')
    expect((await res.json()).data).toEqual({
      sentFirstMessage: true,
      createdProject: true,
      installedAgent: true,
      connectedIntegration: true,
      invitedTeammate: true,
    })
  })

  test('only attributes messages in projects the user created or their personal workspace', async () => {
    await makeApp('u-1').request('/api/me/getting-started')
    expect(s.chatMessageQueries).toHaveLength(1)
    expect(s.chatMessageQueries[0].where).toEqual({
      role: 'user',
      session: {
        OR: [
          { project: { createdBy: 'u-1' } },
          { workspace: { kind: 'personal', members: { some: { userId: 'u-1', projectId: null } } } },
        ],
      },
    })
  })

  test('401s when unauthenticated', async () => {
    const res = await makeApp(null).request('/api/me/getting-started')
    expect(res.status).toBe(401)
  })
})
