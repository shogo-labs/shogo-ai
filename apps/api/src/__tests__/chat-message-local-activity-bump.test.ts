// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// A send on the desktop moves its chat's lastActiveAt in the database (SHO-190).
//
// Goes through `createLocalGeneratedRoutes()` and a real `POST`, not through the
// hook: the bug was that `local-routes.ts` mounted `createChatMessageRoutes()`
// without calling `setChatMessageHooks`, so on the desktop track a message never
// moved `lastActiveAt` and the sidebar row snapped back to its old time ~2s
// after the send. A direct-hook test would pass on main and miss the wiring.

import { beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import {
  bumpChatSessionActivity,
  chatMessageHooks,
  localChatMessageHooks,
} from '../generated/chat-message.hooks'
import { createLocalGeneratedRoutes } from '../generated/local-routes'

const SESSIONS: Record<string, any> = {
  'chat-project': { contextType: 'project', contextId: 'proj-1', workspaceId: 'ws-1' },
  'chat-workspace': { contextType: 'workspace', contextId: null, workspaceId: 'ws-1' },
}

let sessionUpdates: Array<{ where: any; data: any }> = []
let projectUpdates: Array<{ where: any; data: any }> = []
let createArgs: any[] = []

function makePrisma() {
  return {
    chatMessage: {
      create: async (args: any) => {
        createArgs.push(args)
        return { id: 'msg-1', createdAt: new Date(), ...args.data }
      },
    },
    chatSession: {
      findUnique: async ({ where }: any) => SESSIONS[where.id] ?? null,
      update: async (args: any) => {
        sessionUpdates.push(args)
        return SESSIONS[args.where.id] ?? null
      },
    },
    project: {
      update: async (args: any) => {
        projectUpdates.push(args)
        return { id: args.where.id }
      },
    },
  }
}

function makeLocalApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { userId: 'user-1' })
    await next()
  })
  app.route('/api', createLocalGeneratedRoutes(makePrisma() as any))
  return app
}

function postMessage(sessionId: string) {
  return makeLocalApp().request('/api/chat-messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, role: 'user', content: 'quick question' }),
  })
}

beforeEach(() => {
  sessionUpdates = []
  projectUpdates = []
  createArgs = []
})

describe('POST /api/chat-messages on the local route set', () => {
  test('moves the session lastActiveAt to the new message', async () => {
    const before = Date.now()
    const response = await postMessage('chat-workspace')

    expect(response.status).toBe(201)
    expect(sessionUpdates).toHaveLength(1)
    expect(sessionUpdates[0].where).toEqual({ id: 'chat-workspace' })
    const stamped = new Date(sessionUpdates[0].data.lastActiveAt).getTime()
    expect(stamped).toBeGreaterThanOrEqual(before)
    // `updatedAt` rides along: the row's own "last touched" stamp.
    expect(sessionUpdates[0].data.updatedAt).toEqual(sessionUpdates[0].data.lastActiveAt)
  })

  test('a project chat also moves the project lastMessageAt', async () => {
    const response = await postMessage('chat-project')

    expect(response.status).toBe(201)
    expect(sessionUpdates[0].where).toEqual({ id: 'chat-project' })
    expect(projectUpdates).toHaveLength(1)
    expect(projectUpdates[0].where).toEqual({ id: 'proj-1' })
    expect(projectUpdates[0].data.lastMessageAt).toEqual(sessionUpdates[0].data.lastActiveAt)
  })

  test('a workspace chat touches no project', async () => {
    await postMessage('chat-workspace')

    expect(projectUpdates).toEqual([])
  })

  test('the message itself is still created with the posted fields', async () => {
    await postMessage('chat-workspace')

    expect(createArgs).toHaveLength(1)
    expect(createArgs[0].data).toMatchObject({
      sessionId: 'chat-workspace',
      role: 'user',
      content: 'quick question',
    })
  })
})

describe('the cloud hook set', () => {
  test('runs the same bump as the desktop set', () => {
    // One function, two hook sets: the desktop fix cannot drift from cloud.
    expect(chatMessageHooks.afterCreate).toBe(bumpChatSessionActivity as any)
    expect(localChatMessageHooks.afterCreate).toBe(bumpChatSessionActivity as any)
  })

  // AC7: the extraction left cloud behaviour unchanged. Calls the exact hook
  // `generated/index.ts` installs via `setChatMessageHooks(chatMessageHooks)`.
  test('still moves lastActiveAt and the project stamp', async () => {
    await chatMessageHooks.afterCreate!(
      { sessionId: 'chat-project' },
      { prisma: makePrisma(), body: {}, params: {}, query: {} } as any,
    )

    expect(sessionUpdates).toHaveLength(1)
    expect(sessionUpdates[0].where).toEqual({ id: 'chat-project' })
    expect(sessionUpdates[0].data.lastActiveAt).toEqual(sessionUpdates[0].data.updatedAt)
    expect(projectUpdates).toHaveLength(1)
    expect(projectUpdates[0]).toMatchObject({
      where: { id: 'proj-1' },
      data: { lastMessageAt: sessionUpdates[0].data.lastActiveAt },
    })
  })

  test('still leaves a workspace chat’s project alone', async () => {
    await chatMessageHooks.afterCreate!(
      { sessionId: 'chat-workspace' },
      { prisma: makePrisma(), body: {}, params: {}, query: {} } as any,
    )

    expect(sessionUpdates).toHaveLength(1)
    expect(projectUpdates).toEqual([])
  })
})
