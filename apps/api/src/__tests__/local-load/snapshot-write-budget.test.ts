// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-277 — a turn's snapshot writes are coalesced, and nothing is lost.
 *
 * The relay used to rewrite the whole growing assistant message once per tool
 * result: a 110-tool turn was 110 `JSON.stringify` + `UPDATE`s of a message
 * that reached ~1 MB, on the API's synchronous bun:sqlite connection. Coalescing
 * them is only safe if the final row still equals what the stream produced, so
 * this test asserts both halves:
 *
 *   1. at most one write per second of stream time, plus the final one;
 *   2. the persisted `content` and `parts` are exactly the streamed turn,
 *      byte for byte.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setupChannelsTestDb } from '../helpers/channels-test-db'
import { makeAgentTurnFrames, makeTimedSseStream } from '../helpers/fake-runtime-stream'

const { dir } = setupChannelsTestDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'shogo-snapshot-'))
process.env.WORKSPACES_DIR = workspacesDir
process.env.SHOGO_LOCAL_MODE = 'true'

const { prisma } = await import('../../lib/prisma')
const { trackUsageFromStream } = await import('../../routes/project-chat')

const db = prisma as any

interface Write {
  bytes: number
  at: number
  parts: string | null
}

const writes: Write[] = []
const realUpdate = db.chatMessage.update.bind(db.chatMessage)
db.chatMessage.update = async (args: any) => {
  writes.push({
    bytes: typeof args?.data?.parts === 'string' ? args.data.parts.length : 0,
    at: Date.now(),
    parts: typeof args?.data?.parts === 'string' ? args.data.parts : null,
  })
  return realUpdate(args)
}

const TOOL_COUNT = 110
const TURN_MS = 4_000
const FRAME_INTERVAL_MS = Math.max(1, Math.round(TURN_MS / (TOOL_COUNT * 2)))

describe('assistant snapshot writes', () => {
  afterAll(async () => {
    await db.$disconnect?.()
    rmSync(workspacesDir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  test('a 110-tool turn writes at most once a second and ends byte-equal', async () => {
    const suffix = crypto.randomUUID().slice(0, 8)
    const user = await db.user.create({ data: { name: 'snap', email: `snap-${suffix}@example.com` } })
    const workspace = await db.workspace.create({ data: { name: 'Snap', slug: `snap-${suffix}`, kind: 'team' } })
    await db.member.create({ data: { userId: user.id, workspaceId: workspace.id, role: 'owner' } })
    const project = await db.project.create({ data: { name: 'Snap Project', workspaceId: workspace.id } })
    const session = await db.chatSession.create({
      data: { inferredName: 'Snap Chat', name: 'Snap Chat', contextType: 'project', contextId: project.id },
    })

    const script = makeAgentTurnFrames({ toolCount: TOOL_COUNT, turnId: `snap-${suffix}` })
    writes.length = 0
    const startedAt = Date.now()

    await trackUsageFromStream(
      makeTimedSseStream(script.frames, FRAME_INTERVAL_MS),
      { chatSessionId: session.id, agentMode: 'advanced' },
      { id: project.id, workspaceId: workspace.id },
      { chatSessionId: session.id, suppressCompletionPush: true },
    )

    const streamMs = Date.now() - startedAt
    const budget = Math.ceil(streamMs / 1000) + 2
    expect({
      writes: writes.length,
      budget,
      streamMs,
    }).toMatchObject({ writes: expect.any(Number), budget: expect.any(Number), streamMs: expect.any(Number) })
    expect(writes.length).toBeLessThanOrEqual(budget)

    // The final write is the turn, not an intermediate step.
    const rows = await db.chatMessage.findMany({ where: { sessionId: session.id } })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.role).toBe('assistant')
    expect(row.content).toBe(script.text)

    const parts = JSON.parse(row.parts)
    const toolParts = parts.filter((part: any) => part.type === 'dynamic-tool')
    expect(toolParts).toHaveLength(TOOL_COUNT)
    for (const [i, expected] of script.toolOutputs.entries()) {
      expect(toolParts[i].toolCallId).toBe(expected.toolCallId)
      expect(toolParts[i].toolName).toBe(expected.toolName)
      expect(toolParts[i].output).toEqual(expected.output)
      expect(toolParts[i].state).toBe('output-available')
    }
    // The turn-timing part the client's "Worked for X" header reads.
    expect(parts.at(-1)?.type).toBe('data-turn-timing')
    // The last write is what is in the row: no later write was skipped.
    expect(writes.at(-1)?.parts).toBe(row.parts)
  }, 120_000)
})
