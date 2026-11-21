// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-482: a failed dispatch must not be able to kill the API.
 *
 * The reported crash was `Chat proxy returned 500 … timed out` from
 * `startClaimedRow → dispatchNext → drainSessionAfterTurn`. `startClaimedRow`
 * did catch `dispatchRow`, but its catch block ran `releaseTaskWake`,
 * `collapseFailedWakeRows` and the resume-note import bare — so a throw there
 * rejected the handler itself, and on the desktop (no
 * `unhandledRejection` handler at all) Bun exited.
 *
 * Both halves are pinned here: the row still ends up `failed` with the real
 * reason, and nothing escapes as an unhandled rejection when the cleanup also
 * throws.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

const PROXY_DETAIL = 'Chat proxy returned 500: upstream timed out'

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))
mock.module('../routes/project-chat', () => ({
  trackUsageFromStream: async () => undefined,
  projectChatRoutes: () => ({
    fetch: async () => new Response('upstream timed out', { status: 500 }),
  }),
}))
// The cleanup step the catch block runs at the resume cap. It throws. Spread
// the real module so nothing else that imports it loses an export.
const realChatResume = await import('../services/chat-resume.service')
mock.module('../services/chat-resume.service', () => ({
  ...realChatResume,
  postInterruptedResume: async () => {
    throw new Error('cleanup exploded')
  },
}))

const { prisma } = await import('../lib/prisma')
const { dispatchNext } = await import('../services/chat-queue-dispatcher.service')
const { MAX_WAKE_ATTEMPTS } = await import('../services/background-tasks.service')

const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(() => {})

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

/** A resume at the cap: its catch path is the one that posts the stopped note. */
async function queueResume(session: string): Promise<any> {
  const prompt = 'Pick up exactly where you left off.'
  return db.chatQueuedMessage.create({
    data: {
      sessionId: session,
      userId: seed.owner,
      position: 0,
      status: 'pending',
      kind: 'resume',
      content: prompt,
      parts: JSON.stringify([{ type: 'text', text: prompt }, { type: 'data-resume', data: { toolName: 'exec' } }]),
      body: JSON.stringify({ text: prompt, resumeAttempts: MAX_WAKE_ATTEMPTS - 1 }),
    },
  })
}

describe('a dispatch failure whose cleanup also throws (SHO-482)', () => {
  test('resolves false, keeps the row failed with the real reason, and nothing goes unhandled', async () => {
    const session = await newSession()
    const row = await queueResume(session)

    const escaped: unknown[] = []
    const onRejection = (reason: unknown) => {
      escaped.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    let started: boolean | undefined
    try {
      // A rejection here fails the test: this is the call that used to escape.
      started = await dispatchNext(session)
      // Give an escaped promise a turn to surface.
      await new Promise((resolve) => setTimeout(resolve, 25))
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }

    expect(started).toBe(false)
    expect(escaped).toEqual([])

    const after = await db.chatQueuedMessage.findUnique({ where: { id: row.id } })
    expect(after.status).toBe('failed')
    expect(after.error).toContain(PROXY_DETAIL)
    // It is the proxy failure the row records — not the cleanup's error.
    expect(after.error).not.toContain('cleanup exploded')
  })

  test('the cleanup bug is logged rather than swallowed', async () => {
    const session = await newSession()
    await queueResume(session)

    const warnings: string[] = []
    const realWarn = console.warn
    const realError = console.error
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    console.error = () => {}
    try {
      await dispatchNext(session)
    } finally {
      console.warn = realWarn
      console.error = realError
    }

    expect(warnings.join('\n')).toContain('Post-failure stopped-resume note')
    expect(warnings.join('\n')).toContain('cleanup exploded')
  })
})
