// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A finished `project_call` has to leave its answer in the called project's
 * chat — Russell's report was a thread with the prompt and nothing else.
 *
 * Runs the real call service, the real ChatMessage/ChatSession tables (a temp
 * SQLite replayed from the desktop migrations) and the real list hook. Only the
 * callee runtime's HTTP surface is stubbed, so what is asserted is the rows the
 * UI reads.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

mock.module('../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'test-runtime-token',
}))

const { prisma } = await import('../lib/prisma')
const callSvc = await import('../services/agent-call.service')
const { chatMessageHooks } = await import('../generated/chat-message.hooks')
const agentCallStore = await import('../lib/agent-call-store')

const db = prisma as any
let seed: SeededWorkspace

const CALLEE_URL = 'http://callee-runtime.test'
const realFetch = globalThis.fetch
const realResolver = callSvc.setProjectRuntimeUrlResolver
let trackerText = 'PONG'

beforeAll(async () => {
  seed = await seedWorkspace(db)
  callSvc.setProjectRuntimeUrlResolver(() => CALLEE_URL)
  callSvc.setCallTurnDeps({
    track: (async () => ({ outcome: 'complete', status: 'completed', text: trackerText, assistantMessageId: null })) as any,
    markTurnStarted: async () => 'turn-1',
    markTurnEnded: async () => {},
    startTurnHeartbeat: () => () => {},
    turnPollIntervalMs: 1,
  })
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.endsWith('/agent/pipeline/call')) {
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 })
    }
    if (u.includes('/turn')) {
      // Still active: this side has no text of its own, the way the tracker
      // leaves things when the callee turn produced no content.
      return new Response(JSON.stringify({ turnId: 't1', status: 'active', createdAt: Date.now() }), { status: 200 })
    }
    if (u.includes('/stream')) {
      return new Response('data: {"type":"text-delta"}\n\n', { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as any
})

afterAll(async () => {
  globalThis.fetch = realFetch
  callSvc.setProjectRuntimeUrlResolver(null)
  callSvc.setCallTurnDeps(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

/** The rows the technical chat panel lists for a session, newest first. */
async function chatRows(chatSessionId: string) {
  return db.chatMessage.findMany({ where: { sessionId: chatSessionId }, orderBy: { createdAt: 'asc' } })
}

/** Run the list hook the per-agent transcript read goes through. */
async function openTechnicalChat(chatSessionId: string) {
  const result = await chatMessageHooks.beforeList!({
    body: {},
    params: {},
    query: { sessionId: chatSessionId, agent: 'technical' },
    userId: seed.owner,
    tunnelAuthenticated: true,
    prisma: db,
  })
  return result
}

async function settled(projectId: string, runId: string) {
  for (let i = 0; i < 200; i++) {
    const record = await agentCallStore.getAgentCall(projectId, runId)
    if (record && record.status !== 'running') return record
    await new Promise((r) => setTimeout(r, 5))
  }
  return agentCallStore.getAgentCall(projectId, runId)
}

/** The record settles before its chat row is written, so wait for both. */
async function settledChat(projectId: string, runId: string, chatSessionId: string) {
  const record = await settled(projectId, runId)
  for (let i = 0; i < 200; i++) {
    const rows = await chatRows(chatSessionId)
    if (rows.some((r: any) => r.role === 'assistant')) return record
    await new Promise((r) => setTimeout(r, 5))
  }
  return record
}

describe('project_call chat persistence', () => {
  test('a tracked call leaves the prompt and the reply in the callee chat, once', async () => {
    const projectId = seed.projectId
    const runId = 'run-integration-1'
    trackerText = 'PONG'

    const out = await callSvc.callProjectAgentAsChat({} as any, projectId, seed.workspaceId, {
      message: 'Reply with PONG',
      runId,
      wait: false,
      track: true,
      callerProjectId: seed.foreignProjectId,
    })
    expect(out.status).toBe(202)
    const chatSessionId = out.body.chatSessionId as string
    expect(chatSessionId).toBe(callSvc.runChatSessionId(projectId, runId))

    const record = await settledChat(projectId, runId, chatSessionId)
    expect(record).toMatchObject({ status: 'completed', reply: 'PONG' })

    const rows = await chatRows(chatSessionId)
    expect(rows.map((r: any) => [r.role, r.agent, r.content])).toEqual([
      ['user', 'project_call', 'Reply with PONG'],
      ['assistant', 'technical', 'PONG'],
    ])
    expect(JSON.parse(rows[1].parts)).toEqual([{ type: 'text', text: 'PONG' }])

    // Opening the chat twice must not add a second answer.
    await openTechnicalChat(chatSessionId)
    await openTechnicalChat(chatSessionId)
    expect((await chatRows(chatSessionId)).filter((r: any) => r.role === 'assistant')).toHaveLength(1)
  })

  test('a call whose turn produced no text leaves an explicit failure row, not a blank thread', async () => {
    const projectId = seed.projectId
    const runId = 'run-integration-2'
    trackerText = ''

    const out = await callSvc.callProjectAgentAsChat({} as any, projectId, seed.workspaceId, {
      message: 'Say nothing',
      runId,
      wait: false,
      track: true,
    })
    expect(out.status).toBe(202)
    const chatSessionId = out.body.chatSessionId as string

    await settledChat(projectId, runId, chatSessionId)

    const rows = await chatRows(chatSessionId)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ role: 'assistant', agent: 'technical' })
    expect(rows[1].content).toContain('ended before its reply could be saved')

    // And it stays a single row when the chat is opened.
    await openTechnicalChat(chatSessionId)
    expect(await chatRows(chatSessionId)).toHaveLength(2)
  })

  test('opening a call chat orphaned before the fix writes its reply from the call record', async () => {
    const projectId = seed.projectId
    const runId = 'run-integration-3'
    const chatSessionId = callSvc.runChatSessionId(projectId, runId)

    // The state main leaves behind: a session, the prompt, a finished record
    // with the reply, and no assistant row.
    await db.chatSession.create({
      data: { id: chatSessionId, inferredName: 'Caller: orphan', contextType: 'project', contextId: projectId },
    })
    await db.chatMessage.create({
      data: {
        sessionId: chatSessionId,
        role: 'user',
        content: 'Reply with PONG',
        parts: JSON.stringify([
          { type: 'text', text: 'Reply with PONG' },
          { type: 'data-project-call', data: { runId, callerName: 'Caller' } },
        ]),
        agent: 'project_call',
      },
    })
    await agentCallStore.linkAgentCallSession(chatSessionId, { projectId, runId, startedAt: Date.now() })
    await agentCallStore.putAgentCall(projectId, {
      status: 'completed',
      runId,
      sessionId: chatSessionId,
      chatSessionId,
      reply: 'PONG',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    })

    const result = await openTechnicalChat(chatSessionId)
    expect(result?.ok).toBe(true)

    const rows = await chatRows(chatSessionId)
    expect(rows.map((r: any) => [r.role, r.content])).toEqual([
      ['user', 'Reply with PONG'],
      ['assistant', 'PONG'],
    ])

    await openTechnicalChat(chatSessionId)
    expect(await chatRows(chatSessionId)).toHaveLength(2)
  })
})
