// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-317 — one agent run, one count.
 *
 * The update banner said "interrupted 19 agent runs" when four agents were
 * running. `countLiveWork` returned three counts and the desktop summed them:
 * live turns, every running background task (mostly card watches, which survive
 * a restart and fire on the next boot) and every running team-chat reply (the
 * same runs as the live turns, counted again).
 *
 * This drives the real counter against a real database with exactly Russell's
 * shape — 4 live sessions, 2 replies on those sessions, 7 card watches, 2 other
 * watches, a shell command and one orphaned reply — and asserts the answer is 4.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb, seedWorkspace, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { countLiveWork } = await import('../lib/machine-snapshot')

const db = prisma as any
let seed: SeededWorkspace
let conversationId: string

beforeAll(async () => {
  seed = await seedWorkspace(db)
  const conversation = await db.conversation.create({
    data: { workspaceId: seed.workspaceId, name: 'general', kind: 'public', createdById: seed.owner },
  })
  conversationId = conversation.id
})

afterEach(async () => {
  await db.backgroundTask.deleteMany({})
  await db.conversationMessage.deleteMany({})
  await db.chatSession.deleteMany({})
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function liveSession(heartbeat = new Date()): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Working', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  await db.chatSession.update({
    where: { id: session.id },
    data: { activeTurnId: `turn-${session.id}`, activeTurnStartedAt: heartbeat, activeTurnHeartbeatAt: heartbeat },
  })
  return session.id
}

let seq = 1
async function agentReply(opts: { agentSessionId?: string | null; createdAt?: Date } = {}) {
  seq += 1
  return db.conversationMessage.create({
    data: {
      conversationId,
      workspaceId: seed.workspaceId,
      seq,
      authorType: 'agent',
      text: 'working on it',
      agentStatus: 'running',
      agentSessionId: opts.agentSessionId ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  })
}

async function task(source: string, chatSessionId: string) {
  return db.backgroundTask.create({
    data: {
      id: `t_${source}_${crypto.randomUUID().slice(0, 8)}`,
      chatSessionId,
      source,
      targetRef: `ref-${source}`,
      title: source,
      status: 'running',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
}

describe('countLiveWork', () => {
  test('counts agent runs, not rows: 4 live sessions stay 4 with watches and replies around them', async () => {
    const { TURN_REATTACH_AFTER_MS } = await import('../services/chat-turn-state.service')
    const staleBefore = new Date(Date.now() - TURN_REATTACH_AFTER_MS)

    const sessions = [await liveSession(), await liveSession(), await liveSession(), await liveSession()]

    // Two of the runs are team-chat replies: the same run as their session.
    await agentReply({ agentSessionId: sessions[0] })
    await agentReply({ agentSessionId: sessions[1] })
    // A reply whose session stopped heartbeating long ago is an orphan the sweep
    // settles — it is not a run a restart would interrupt.
    await agentReply({
      agentSessionId: sessions[2],
      createdAt: new Date(Date.now() - TURN_REATTACH_AFTER_MS - 60_000),
    })

    // Card watches are DB rows: they survive the restart and fire on the next boot.
    for (let i = 0; i < 7; i += 1) await task('work_item', sessions[0])
    await task('agent_reply', sessions[1])
    await task('project_call', sessions[0])
    // A shell command is a process: it dies, but it is not an agent run.
    await task('shell', sessions[3])

    const counts = await countLiveWork(db, { staleTurnBefore: staleBefore, agentReplies: true })
    expect(counts.agentRuns).toBe(4)
    expect(counts.backgroundCommands).toBe(1)
    // The legacy fields are still reported for an older desktop shell.
    expect(counts).toMatchObject({ liveTurns: 4, runningTasks: 10, runningAgentReplies: 3 })
  })

  test('an unattached dispatch inside the window is one more run', async () => {
    const { TURN_REATTACH_AFTER_MS } = await import('../services/chat-turn-state.service')
    const staleBefore = new Date(Date.now() - TURN_REATTACH_AFTER_MS)

    const sessions = [await liveSession(), await liveSession(), await liveSession(), await liveSession()]
    await agentReply({ agentSessionId: sessions[0] })
    await agentReply({ agentSessionId: sessions[1] })

    // Mentioned, dispatched, session not open yet.
    await agentReply({ agentSessionId: null })

    const counts = await countLiveWork(db, { staleTurnBefore: staleBefore, agentReplies: true })
    expect(counts.agentRuns).toBe(5)
  })

  test('a stale unattached reply does not count — the sweep settles it', async () => {
    const { TURN_REATTACH_AFTER_MS, DEFAULT_STALE_AFTER_MS } = await import(
      '../services/chat-turn-state.service'
    )
    const staleBefore = new Date(Date.now() - TURN_REATTACH_AFTER_MS)
    await liveSession()
    await agentReply({
      agentSessionId: null,
      createdAt: new Date(Date.now() - DEFAULT_STALE_AFTER_MS - 60_000),
    })

    const counts = await countLiveWork(db, { staleTurnBefore: staleBefore, agentReplies: true })
    expect(counts.agentRuns).toBe(1)
  })

  test('a dead turn is not live, and neither is its reply', async () => {
    const { TURN_REATTACH_AFTER_MS } = await import('../services/chat-turn-state.service')
    const staleBefore = new Date(Date.now() - TURN_REATTACH_AFTER_MS)
    const dead = new Date(Date.now() - TURN_REATTACH_AFTER_MS - 60_000)
    const sessionId = await liveSession(dead)
    await agentReply({ agentSessionId: sessionId })

    const counts = await countLiveWork(db, { staleTurnBefore: staleBefore, agentReplies: true })
    expect(counts.agentRuns).toBe(0)
  })

  test('the cloud heartbeat gets the same run count, without the reply/reply union', async () => {
    await liveSession()
    await agentReply({ agentSessionId: null })
    // No `agentReplies`, no cutoff: every session holding a turn counts, which is
    // the historical behaviour the machine card has always shown.
    const counts = await countLiveWork(db)
    expect(counts.agentRuns).toBe(1)
  })
})
