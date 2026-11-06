// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-347 (PERF-20).
 *
 * The dev's unit tests prove each piece: the claim picks one winner, the sweep
 * ticks at 60 s, the indexer takes a window. This file covers the seams between
 * them — the things that would silently put the 15 s scan back or make the new
 * index unusable:
 *
 *  1. `runChatQueueDrain` (15 s, every pod, no lock) must NOT sweep dead
 *     replies any more. That is the whole point of the card, and re-adding one
 *     `await` there would restore the old cost without failing any other test.
 *  2. The worker actually ticks on start, keeps ticking every 60 s, and stops —
 *     the sweep only helps if the timer is what runs it.
 *  3. The partial index predicate and the sweep query filter still describe the
 *     same rows. Postgres only uses a partial index when the query implies its
 *     predicate; a filter drifting outside it turns the index into dead weight
 *     on the hottest insert path in the system.
 *  4. Both migration tracks create the two indexes with `IF NOT EXISTS`, so the
 *     out-of-band `CREATE INDEX CONCURRENTLY` in the PR body is a no-op at pod
 *     boot instead of a write lock on `conversation_messages`.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../../..')

const calls = { sweeps: 0, drains: 0 }

mock.module('../services/chat-queue-dispatcher.service', () => ({
  resetStuckDispatching: async () => {
    calls.drains++
  },
  dispatchPendingSessions: async () => {},
}))
mock.module('../services/background-tasks.service', () => ({
  reconcileStuckTasks: async () => {},
  sweepUnnotifiedWakes: async () => {},
}))
mock.module('../services/conversation-agent-dispatcher', () => ({
  sweepPendingAgentWakes: async () => {},
  sweepDeadAgentReplies: async () => {
    calls.sweeps++
    return 0
  },
}))
mock.module('../lib/prisma', () => ({
  prisma: {
    platformSetting: {
      updateMany: async () => ({ count: 1 }),
      create: async () => ({}),
    },
  },
}))
mock.module('../lib/global-job-lock', () => ({
  withGlobalJobLock: async (_name: string, body: () => Promise<unknown>) => ({
    acquired: true,
    result: await body(),
  }),
}))

const { runChatQueueDrain } = await import('../jobs/run-chat-queue-drain')
const { startChatSweepWorker, stopChatSweepWorker, runDeadAgentReplySweep } = await import(
  '../jobs/run-chat-sweep'
)

beforeEach(() => {
  calls.sweeps = 0
  calls.drains = 0
})

afterEach(() => {
  stopChatSweepWorker()
  jest.useRealTimers()
})

describe('the 15 s queue drain is not the sweep path any more', () => {
  it('does not settle dead replies, so no pod scans on that cadence', async () => {
    await runChatQueueDrain()
    expect(calls.drains).toBe(1)
    expect(calls.sweeps).toBe(0)
  })

  it('settles them on the sweep job instead', async () => {
    await runDeadAgentReplySweep()
    expect(calls.sweeps).toBe(1)
  })
})

describe('the sweep worker timer', () => {
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  it('ticks on start, then every 60 s, and stops when asked', async () => {
    jest.useFakeTimers()
    startChatSweepWorker()
    await flush()
    expect(calls.sweeps).toBe(1)

    jest.advanceTimersByTime(60_000)
    await flush()
    expect(calls.sweeps).toBe(2)

    jest.advanceTimersByTime(3 * 60_000)
    await flush()
    expect(calls.sweeps).toBe(5)

    stopChatSweepWorker()
    jest.advanceTimersByTime(10 * 60_000)
    await flush()
    expect(calls.sweeps).toBe(5)
  })

  it('starting twice does not double the timer', async () => {
    jest.useFakeTimers()
    startChatSweepWorker()
    startChatSweepWorker()
    await flush()
    expect(calls.sweeps).toBe(1)

    jest.advanceTimersByTime(60_000)
    await flush()
    expect(calls.sweeps).toBe(2)
  })
})

describe('the partial index still fits the sweep query', () => {
  const SWEEP_PREDICATE = {
    authorType: "'agent'",
    agentStatus: "'running'",
    deletedAt: 'IS NULL',
  }

  const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

  for (const schema of ['prisma/schema.prisma', 'prisma/schema.local.prisma']) {
    it(`${schema} declares the partial index with the sweep's three columns`, () => {
      const text = read(schema)
      const line = text
        .split('\n')
        .find((l) => l.includes('conversation_messages_running_agent_idx'))
      expect(line).toBeDefined()
      // The schema escapes the inner quotes of the raw() predicate; compare
      // against the unescaped text so the assertion is about the predicate.
      const predicate = (line ?? '').replace(/\\/g, '')
      expect(predicate).toContain('@@index([threadRootId]')
      for (const [column, literal] of Object.entries(SWEEP_PREDICATE)) {
        const rendered = column === 'deletedAt' ? `"${column}" ${literal}` : `"${column}" = ${literal}`
        expect(predicate).toContain(rendered)
      }
    })

    it(`${schema} also declares the createdAt index the fast pass reads`, () => {
      const text = read(schema)
      const conversationMessage = text.slice(text.indexOf('model ConversationMessage {'))
      expect(conversationMessage.slice(0, conversationMessage.indexOf('@@map('))).toContain(
        '@@index([createdAt])',
      )
    })
  }

  const MIGRATIONS = [
    'prisma/migrations/20261105160000_sho347_chat_sweep_indexes/migration.sql',
    'apps/desktop/prisma/migrations/20261105160000_sho347_chat_sweep_indexes/migration.sql',
  ]

  for (const migration of MIGRATIONS) {
    it(`${migration} creates both indexes without locking a pre-built one`, () => {
      const sql = read(migration)
      expect(sql).toContain(
        'CREATE INDEX IF NOT EXISTS "conversation_messages_createdAt_idx" ON "conversation_messages"("createdAt")',
      )
      expect(sql).toContain(
        'CREATE INDEX IF NOT EXISTS "conversation_messages_running_agent_idx" ON "conversation_messages"("threadRootId") WHERE "agentStatus" = \'running\' AND "authorType" = \'agent\' AND "deletedAt" IS NULL',
      )
      // No third index: the plan caps this at the two the queries need.
      expect(sql.match(/^CREATE INDEX/gm)).toHaveLength(2)
    })
  }

  it('the sweep query filters exactly the indexed columns, so Postgres can use the index', () => {
    const dispatcher = readFileSync(
      join(ROOT, 'apps/api/src/services/conversation-agent-dispatcher.ts'),
      'utf-8',
    )
    const start = dispatcher.indexOf('export async function sweepDeadAgentReplies')
    const body = dispatcher.slice(start, dispatcher.indexOf('select: { id: true, threadRootId', start))
    for (const [column, literal] of Object.entries(SWEEP_PREDICATE)) {
      expect(body).toContain(
        column === 'deletedAt' ? 'deletedAt: null' : `${column}: ${literal}`,
      )
    }
    expect(body).toContain('threadRootId: { not: null }')
  })
})
