// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The name a channel run stores on its session is what the chat list, the
 * session history and "Running now" show, and the mention tokens exist only
 * while the message is being handled (SHO-425). These are the rules that keep
 * it readable: the card wins, the tag that woke the agent goes, and everybody
 * else keeps their name.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const workItemFindFirst = mock(async (): Promise<unknown> => null)
const userFindMany = mock(async (): Promise<unknown[]> => [])
const projectFindMany = mock(async (): Promise<unknown[]> => [])
const chatSessionFindMany = mock(async (): Promise<unknown[]> => [])
const profileFindUnique = mock(async (): Promise<unknown> => null)
mock.module('../../lib/prisma', () => ({
  prisma: {
    workItem: { findFirst: workItemFindFirst },
    user: { findMany: userFindMany },
    project: { findMany: projectFindMany },
    chatSession: { findMany: chatSessionFindMany },
    workspaceAgentProfile: { findUnique: profileFindUnique },
  },
}))

const { chatSessionLabel } = await import('../chat-session-label')

const DEV2 = { projectId: 'proj-dev2' }
const token = (projectId: string) => `<@a:p:${projectId}>`

beforeEach(() => {
  workItemFindFirst.mockClear()
  userFindMany.mockClear()
  projectFindMany.mockClear()
  chatSessionFindMany.mockClear()
  profileFindUnique.mockClear()
  workItemFindFirst.mockResolvedValue(null)
  userFindMany.mockResolvedValue([])
  projectFindMany.mockResolvedValue([])
  profileFindUnique.mockResolvedValue({ name: 'Shogo' })
})

describe('chatSessionLabel', () => {
  test('renders the agent by name and drops the tag that woke it', async () => {
    projectFindMany.mockResolvedValue([{ id: 'proj-dev2', name: 'Shogo Dev 2' }])

    expect(await chatSessionLabel({
      workspaceId: 'ws',
      conversationName: 'shogo-dev',
      text: `${token('proj-dev2')} fix SHO-421 on your branch, then hand it to QA`,
      target: DEV2,
      threadRootId: 'thread-1',
    })).toBe('#shogo-dev: fix SHO-421 on your branch, then hand it to QA')
  })

  test('never stores the unresolved `@agent` fallback the row used to read', async () => {
    // The project lookup misses: the old code rendered `@agent` here, which is
    // what filled every "Running now" row with the same title.
    expect(await chatSessionLabel({
      workspaceId: 'ws',
      conversationName: 'shogo-dev',
      text: `${token('proj-dev2')} plan a card for this and begin`,
      target: DEV2,
      threadRootId: null,
    })).toBe('#shogo-dev: plan a card for this and begin')
  })

  test('keeps other people and agents in the text, by their real names', async () => {
    projectFindMany.mockResolvedValue([
      { id: 'proj-dev2', name: 'Shogo Dev 2' },
      { id: 'proj-qa', name: 'Shogo QA' },
    ])
    userFindMany.mockResolvedValue([{ id: 'user-1', name: 'Russell', email: 'r@example.com' }])

    expect(await chatSessionLabel({
      workspaceId: 'ws',
      conversationName: 'shogo-dev',
      text: `${token('proj-dev2')} review ${token('proj-qa')}'s PR, <@u:user-1> asked`,
      target: DEV2,
      threadRootId: null,
    })).toBe("#shogo-dev: review @Shogo QA's PR, @Russell asked")
  })

  test('a card thread is named after the card, and nothing else is looked up', async () => {
    workItemFindFirst.mockResolvedValue({ key: 'SHO-421', title: 'A full PR from an empty channel' })

    expect(await chatSessionLabel({
      workspaceId: 'ws',
      conversationName: 'shogo-dev',
      text: `${token('proj-dev2')} fix it`,
      target: DEV2,
      threadRootId: 'thread-on-card',
    })).toBe('SHO-421 · A full PR from an empty channel')

    expect(workItemFindFirst).toHaveBeenCalledWith({
      where: { threadRootMessageId: 'thread-on-card' },
      select: { key: true, title: true },
      orderBy: { createdAt: 'desc' },
    })
    // The card says what the run is; no name round-trips for a label nobody reads.
    expect(projectFindMany).not.toHaveBeenCalled()
    expect(userFindMany).not.toHaveBeenCalled()
  })

  test('a message that is only the tag keeps the tag instead of naming the run nothing', async () => {
    projectFindMany.mockResolvedValue([{ id: 'proj-dev2', name: 'Shogo Dev 2' }])

    expect(await chatSessionLabel({
      workspaceId: 'ws',
      conversationName: 'shogo-dev',
      text: `${token('proj-dev2')}   `,
      target: DEV2,
      threadRootId: null,
    })).toBe('#shogo-dev: @Shogo Dev 2')
  })

  test('a chat with no channel says so', async () => {
    expect(await chatSessionLabel({
      workspaceId: 'ws',
      conversationName: null,
      text: `${token('proj-dev2')} deploy it`,
      target: DEV2,
      threadRootId: null,
    })).toBe('Chat: deploy it')
  })

  test('the workspace agent is named from the workspace profile', async () => {
    profileFindUnique.mockResolvedValue({ name: 'Shogo' })

    expect(await chatSessionLabel({
      workspaceId: 'ws',
      conversationName: 'eng',
      text: '<@a:ws> sanity-check the incident postmortem',
      target: { projectId: null },
      threadRootId: null,
    })).toBe('#eng: sanity-check the incident postmortem')
  })
})
