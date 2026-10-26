// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-137 — a conversation never loses its messages.
 *
 * Russell reported an overnight chat that "completely lost context" when a
 * background job finished. The card's invariant has two halves, and the dev's
 * own tests mock Prisma with an in-memory store, so these drive the **real**
 * SQLite database (replaying the desktop migration track, which is also how the
 * new `contextSummary` columns are proven to apply) through the production
 * entry points the API uses for a one-message turn:
 *
 *   historySeedFor()      → the `historySeed` every wake/queue/schedule sends
 *   budgetThreadContext() → the team-chat prompt builder, same durable summary
 *
 * The assertions use the card's own wording: a prompt is never a stub, every
 * message after `contextSummaryThroughCount` is carried verbatim, and a summary
 * is stable across reads (re-summarising every turn would also destroy the
 * prompt-prefix cache, which the card calls out).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

const { setupChannelsTestDb } = await import('../../__tests__/helpers/channels-test-db')
setupChannelsTestDb()

const svc = await import('../chat-history-seed.service')
const { parseHistorySeed } = await import('../../../../../packages/agent-runtime/src/history-seed')
const { prisma } = await import('../../lib/prisma')

const CANARY = 'canary-sho137-page-one'
let workspaceId: string
let userId: string

/** A summarizer that never calls a model: paid providers must not run in tests. */
let summarizeCalls: Array<{ messages: number }> = []
const stubSummary = 'WHAT THIS IS — deploy triage.\nSTATE — blocked on the migration.\nOPEN — rerun the rollback.'

function installStubSummarizer() {
  summarizeCalls = []
  svc.setChatContextSummarizer(async (input) => {
    summarizeCalls.push({ messages: input.messages.length })
    return stubSummary
  })
}

async function makeSession(name = 'durable-context'): Promise<string> {
  const session = await prisma.chatSession.create({
    data: { inferredName: name, contextType: 'workspace', workspaceId, createdByUserId: userId },
  })
  return session.id
}

let clock = 0
/** Explicit, strictly increasing timestamps: SQLite stores second precision. */
async function addMessage(sessionId: string, role: 'user' | 'assistant', content: string) {
  clock += 1
  const createdAt = new Date(Date.UTC(2026, 9, 21, 9, 0, 0) + clock * 1000)
  const row = await prisma.chatMessage.create({ data: { sessionId, role, content, createdAt } })
  return row as { id: string; createdAt: Date; content: string }
}

beforeAll(async () => {
  const workspace = await prisma.workspace.create({ data: { name: 'qa-sho137', slug: 'qa-sho137', kind: 'team' } })
  workspaceId = workspace.id
  const user = await prisma.user.create({
    data: { email: `qa-sho137-${Date.now()}@example.test`, name: 'QA' },
  })
  userId = user.id
})

afterAll(async () => {
  svc.setChatContextSummarizer(null)
})

beforeEach(() => {
  installStubSummarizer()
  clock = 0
})

describe('AC4 — a one-message turn never carries a stub prompt', () => {
  it('carries every message after the summary watermark verbatim, and a summary for the rest', async () => {
    const sessionId = await makeSession('overnight chat')
    const stored: Array<{ content: string }> = []
    // 90 messages × ~1k chars = ~90k chars, comfortably past the 60k budget.
    for (let i = 0; i < 90; i += 1) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      const body =
        i === 0
          ? `${CANARY}: keep the deploy blocked until the migration runs.`
          : `turn ${i} ${'detail '.repeat(140)}`
      stored.push(await addMessage(sessionId, role as 'user' | 'assistant', body))
    }
    // The wake itself: what a background task finishing posts.
    await addMessage(sessionId, 'user', 'Background task finished: migration applied.')

    const seed = await svc.historySeedFor(sessionId, { excludeNewestUserMessage: true })

    expect(seed).not.toBeNull()
    // Not a one-line note: the tail rides along…
    expect(seed!.messages.length).toBeGreaterThanOrEqual(svc.HISTORY_SEED_TAIL_MESSAGES)
    // …and nothing older was silently dropped: what is not carried verbatim is
    // behind the summary watermark and covered by the summary.
    const session = await prisma.chatSession.findUnique({ where: { id: sessionId } })
    expect(session!.contextSummary).toBe(stubSummary)
    const through = session!.contextSummaryThroughCount
    expect(through).toBeGreaterThan(0)

    const carried = seed!.messages.map((m) => m.text)
    const afterWatermark = stored.slice(through).map((m) => m.content.trim())
    expect(afterWatermark.length).toBeGreaterThanOrEqual(svc.HISTORY_SEED_TAIL_MESSAGES)
    const missing = afterWatermark.filter((t) => !carried.includes(t))
    expect({ missingCount: missing.length, missing: missing.map((t) => t.slice(0, 12)), carriedCount: carried.length, through }).toEqual({ missingCount: 0, missing: [], carriedCount: carried.length, through })
    // The runtime's parser accepts the exact shape the API sends.
    const parsed = parseHistorySeed(JSON.parse(JSON.stringify(seed)))
    expect(parsed!.messages.length).toBe(seed!.messages.length)
    expect(parsed!.summary).toBe(stubSummary)
  })

  it('a conversation that fits the budget is carried whole, first message included', async () => {
    const sessionId = await makeSession('short chat')
    for (let i = 0; i < 12; i += 1) {
      await addMessage(sessionId, i % 2 === 0 ? 'user' : 'assistant', i === 0 ? `${CANARY}: the deploy is blocked` : `turn ${i}`)
    }
    await addMessage(sessionId, 'user', 'Background task finished: migration applied.')

    const seed = await svc.historySeedFor(sessionId, { excludeNewestUserMessage: true })

    expect(JSON.stringify(seed!.messages)).toContain(CANARY)
    expect(seed!.summary).toBeNull()
    // The wake row is the turn itself, never restored twice.
    expect(JSON.stringify(seed!.messages)).not.toContain('migration applied.')
    expect(summarizeCalls).toHaveLength(0)
  })

  it('a wake that is the only row still yields null rather than an empty conversation', async () => {
    const sessionId = await makeSession('brand new')
    await addMessage(sessionId, 'user', 'Background task finished.')
    const seed = await svc.historySeedFor(sessionId, { excludeNewestUserMessage: true })
    expect(seed).toBeNull()
  })
})

describe('AC5 — an over-budget conversation gets one durable, stable summary', () => {
  it('summarises once and returns the same bytes on the next turn', async () => {
    const sessionId = await makeSession('big thread')
    for (let i = 0; i < 80; i += 1) {
      await addMessage(sessionId, i % 2 === 0 ? 'user' : 'assistant', `m${i} ${'x'.repeat(900)}`)
    }

    const first = await svc.historySeedFor(sessionId)
    expect(first!.summary).toBe(stubSummary)
    expect(summarizeCalls).toHaveLength(1)

    const second = await svc.historySeedFor(sessionId)
    expect(second!.summary).toBe(first!.summary)
    // Stable bytes and no second model call: the prompt prefix stays cacheable.
    expect(summarizeCalls).toHaveLength(1)
  })

  it('R2 — the thread budget never writes the summary: one writer, keyed by this session\'s rows', async () => {
    const sessionId = await makeSession('channel agent chat')
    for (let i = 0; i < 60; i += 1) {
      await addMessage(sessionId, i % 2 === 0 ? 'user' : 'assistant', `m${i} ${'y'.repeat(1200)}`)
    }
    // A rendered thread row set, the shape fitThreadBudget takes. Its `seq` is
    // channel-wide: it must never reach `contextSummaryThroughCount`.
    const thread = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      text: `thread ${i} ${'z'.repeat(1200)}`,
      seq: 500 + i,
      authorType: i % 3 === 0 ? 'agent' : 'user',
    }))

    const before = await prisma.chatSession.findUnique({ where: { id: sessionId } })
    const budgeted = svc.fitThreadBudget(thread)
    expect(budgeted.kept.length).toBeLessThan(thread.length)

    const after = await prisma.chatSession.findUnique({ where: { id: sessionId } })
    expect(after!.contextSummary).toBe(before!.contextSummary ?? null)
    expect(after!.contextSummaryThroughCount).toBe(before!.contextSummaryThroughCount ?? 0)

    // The one writer is the seed, over the session's own messages, and its
    // watermark is a `ChatMessage` count — never larger than the rows that exist.
    const count = await prisma.chatMessage.count({ where: { sessionId } })
    await svc.historySeedFor(sessionId, { excludeNewestUserMessage: true })
    const seeded = await prisma.chatSession.findUnique({ where: { id: sessionId } })
    expect(seeded!.contextSummaryThroughCount!).toBeLessThanOrEqual(count)
    expect(seeded!.contextSummary).toBe(stubSummary)
  })
})

describe('AC6 — no chat turn path fabricates an empty session', () => {
  const readRepoFile = (rel: string) =>
    require('node:fs').readFileSync(
      new URL(`../../../../../${rel}`, import.meta.url),
      'utf8',
    ) as string

  it('every turn entry point loads before it creates', () => {
    const server = readRepoFile('packages/agent-runtime/src/server.ts')
    expect(server).toContain('await sessionManager.getOrCreateAsync(chatSessionKey)')
    expect(server).not.toMatch(/sessionManager\.getOrCreate\(\s*chatSessionKey/)

    const gateway = readRepoFile('packages/agent-runtime/src/gateway.ts')
    expect(gateway).toContain('await this.sessionManager.getOrCreateAsync(sessionId)')

    // A turn a person types resends the thread; a wake/queue/schedule sends one
    // message, so each of those builders must attach the stored conversation.
    for (const [file, marker] of [
      ['apps/api/src/services/chat-queue-dispatcher.service.ts', 'historySeedFor(row.sessionId'],
      ['apps/api/src/jobs/agent-turn-runner.ts', 'historySeedFor(input.sessionId)'],
      ['apps/api/src/services/conversation-agent-dispatcher.ts', 'historySeedFor(args.sessionId'],
    ] as const) {
      const source = readRepoFile(file)
      expect(source).toContain(marker)
      expect(source).toContain('historySeed')
    }
  })
})
