// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 4 — the activity panel in a remote workspace.
 *
 * `/activity` is three things in one list: goal events, agent tasks, and the
 * chat turns running right now (`ChatSession.activeTurn*`). A person watching
 * the workspace expects a turn to appear as it starts and drop out as it ends,
 * with no refresh — on every kind of workspace. That is what these checks say,
 * live on the workspace socket, with the stored list read at the end.
 *
 * Needs `CHANNELS_TEST_PG_URL` and `TEST_REDIS_URL`/`REDIS_URL`. Skips without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import { marker } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  TARGET_NAMES,
  TURN_TARGETS,
  LIVE_BUDGET_MS,
  openLive,
  read,
  send,
  startRemoteWorkspace,
  uniq,
  waitFor,
  type RemoteWorkspace,
  type Side,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let ws: RemoteWorkspace
let llm: FakeLlmServer
const target = (name: (typeof TARGET_NAMES)[number]): Target => ws.target(name)

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
  llm = ws.llm
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

/** Start a turn and hand back the response, so the caller can consume it later. */
async function startTurn(side: Side, sessionId: string, text: string): Promise<Response> {
  return fetch(`${side.base}/api/workspaces/${encodeURIComponent(side.workspaceId)}/chat`, {
    method: 'POST',
    headers: { cookie: side.cookie, origin: side.base, 'content-type': 'application/json', 'X-Chat-Session-Id': sessionId },
    body: JSON.stringify({
      id: sessionId,
      chatSessionId: sessionId,
      messages: [{ id: `u-${Math.random().toString(36).slice(2, 10)}`, role: 'user', parts: [{ type: 'text', text }] }],
      trigger: 'submit-message',
    }),
  })
}

async function activity(side: Side): Promise<any[]> {
  const res = await read(side, `/api/workspaces/${encodeURIComponent(side.workspaceId)}/activity?limit=100`)
  return res.data?.activity ?? []
}

const liveTurnRows = (rows: any[], sessionId: string) =>
  rows.filter((row) => row.type === 'chat_turn' && row.chatSessionId === sessionId)

describeIfInfra('remote workspace · activity', () => {
  for (const name of TARGET_NAMES) {
    describe(name, () => {
      // A held turn needs a model to hold: see TURN_TARGETS in harness.ts.
      if (TURN_TARGETS.includes(name)) test('a running turn appears and leaves the activity panel live', async () => {
        const t = target(name)
        const opened = await openLive({ ...t, peer: undefined })
        const socket = opened.live
        const sessionId = t.seed.workspaceChatId
        const tag = `a${name.slice(0, 2)}${Date.now() % 100_000}`
        const turn = await startTurn(t, sessionId, `Activity ${marker('hold', tag, 5, { ms: 5 })}`)
        try {
          // Not `clone().text()` here: this turn is held open on purpose, and
          // reading the body would wait for a model that is still waiting.
          expect(turn.status, `POST /chat answered ${turn.status}`).toBe(200)
          await llm.waitForTurn(tag, 120_000)

          // It is on the socket as soon as the turn starts.
          const startedAt = Date.now()
          const started = await socket.waitForEvent(
            (e) => e.type === 'chat-session.turn' && e.chatSessionId === sessionId && e.state === 'started',
            { label: 'chat-session.turn started', timeoutMs: LIVE_BUDGET_MS },
          )
          expect(started.at - startedAt).toBeLessThanOrEqual(LIVE_BUDGET_MS)

          // …and the panel shows it.
          const running = liveTurnRows(await activity(t), sessionId)
          expect(running.length, JSON.stringify(running)).toBeGreaterThan(0)

          // Release the model: the turn ends, and the socket says so.
          const releasedAt = Date.now()
          llm.release(tag)
          await turn.text().catch(() => '')
          await socket.waitForEvent(
            (e) => e.type === 'chat-session.turn' && e.chatSessionId === sessionId && e.state === 'ended',
            { label: 'chat-session.turn ended', timeoutMs: 15_000, since: releasedAt },
          )

          // …and it drops out of the panel within the budget of that event.
          const endedAt = Date.now()
          await waitFor(
            'the finished turn to leave the activity panel',
            async () => liveTurnRows(await activity(t), sessionId).length === 0,
            LIVE_BUDGET_MS,
            250,
          )
          expect(Date.now() - endedAt).toBeLessThanOrEqual(LIVE_BUDGET_MS + 1_000)
        } finally {
          llm.release(tag)
          socket.close()
        }
      }, 240_000)

      test('goal events and agent tasks show up in the panel', async () => {
        const t = target(name)
        const goalTitle = uniq('goal')
        const progress = uniq('progress note')
        const created = await send(t.api, 'POST', `/api/workspaces/${encodeURIComponent(t.workspaceId)}/goals`, {
          title: goalTitle,
          why: 'because the panel must show it',
          status: 'active',
        })
        expect(created.status, JSON.stringify(created.data)).toBe(201)
        const goalId = created.data?.goal?.id
        expect(goalId).toBeTruthy()

        const logged = await send(
          t.api,
          'POST',
          `/api/workspaces/${encodeURIComponent(t.workspaceId)}/goals/${encodeURIComponent(goalId)}/events`,
          { kind: 'progress', message: progress },
        )
        expect(logged.status, JSON.stringify(logged.data)).toBe(201)

        const taskTitle = uniq('agent task')
        const task = await send(t.api, 'POST', '/api/agent-tasks', {
          workspaceId: t.workspaceId,
          title: taskTitle,
          prompt: 'do the thing',
        })
        expect(task.status, JSON.stringify(task.data)).toBeLessThan(300)

        const rows = await activity(t)
        expect(JSON.stringify(rows)).toContain(progress)
        expect(JSON.stringify(rows)).toContain(taskTitle)
      }, 120_000)
    })
  }
})
