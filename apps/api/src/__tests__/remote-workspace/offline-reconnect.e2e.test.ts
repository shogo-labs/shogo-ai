// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 10 — a remote workspace whose computer goes away.
 *
 * Off means off: a workspace hosted on a paired computer has to stay readable
 * from the cloud while that computer is off, a chat send has to be queued
 * instead of refused, and when the computer comes back the queue has to drain,
 * the socket a page is already holding has to keep delivering, and nothing may
 * arrive twice.
 *
 * Only meaningful for the hosted target — a cloud workspace has no computer to
 * switch off, and the desktop's own API is that computer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import { marker } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  channelMessages,
  openLive,
  read,
  send,
  startRemoteWorkspace,
  uniq,
  waitFor,
  type RemoteWorkspace,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let ws: RemoteWorkspace
let llm: FakeLlmServer
const hosted = (): Target => ws.target('hosted')

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
  llm = ws.llm
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

describeIfInfra('remote workspace · offline and reconnect', () => {
  // Last in the file always: it switches the computer off.
  test('desktop off: readable, a send is queued; back on: it drains and live events resume, once', async () => {
    const t = hosted()
    const peer = t.peer!
    const conv = `/api/conversations/${encodeURIComponent(t.seed.channelId)}/messages`
    // A socket opened while the desktop is up stays open across the outage: a
    // page does not get reloaded, so this is the client that must keep working.
    const { live: socket } = await openLive({ ...t, peer: undefined })

    try {
      await ws.machine.kill()

      // Still readable from the cloud.
      const projects = await read(t, `/api/projects?workspaceId=${encodeURIComponent(t.workspaceId)}`)
      expect(projects.status, projects.error).toBe(200)
      t.seed.projectNames.forEach((name) => expect(JSON.stringify(projects.data)).toContain(name))
      expect((await channelMessages(t, t.seed.channelId)).map((m) => m.text)).toEqual(
        expect.arrayContaining(t.seed.messageTexts),
      )

      // A channel write is a durable row: accepted while the host is off.
      const offlineText = uniq('written while the desktop was off')
      const written = await send(t.api, 'POST', conv, { text: offlineText })
      expect([200, 201], JSON.stringify(written.data)).toContain(written.status)
      await waitFor('the offline write to be listed', async () =>
        (await channelMessages(t, t.seed.channelId)).some((m) => m.text === offlineText), 15_000, 250)

      // A chat send is queued, not refused, and does not run in the cloud.
      const tag = `off${Date.now() % 100_000}`
      const turn = await fetch(`${t.base}/api/workspaces/${encodeURIComponent(t.workspaceId)}/chat`, {
        method: 'POST',
        headers: {
          cookie: t.cookie,
          origin: t.base,
          'content-type': 'application/json',
          'X-Chat-Session-Id': t.seed.workspaceChatId,
        },
        body: JSON.stringify({
          id: t.seed.workspaceChatId,
          chatSessionId: t.seed.workspaceChatId,
          messages: [{ id: `u-${tag}`, role: 'user', parts: [{ type: 'text', text: `Queued ${marker('long', tag, 3, { ms: 5 })}` }] }],
          trigger: 'submit-message',
        }),
      })
      const turnBody: any = await turn.json().catch(() => null)
      expect(turn.status, JSON.stringify(turnBody)).toBe(202)
      expect(turnBody?.error?.code).toBe('host_offline')
      expect(llm.requestsFor(tag).length).toBe(0)

      await ws.machine.restart()

      // The queued turn runs on the desktop.
      await waitFor('the queued turn on the desktop', async () => llm.requestsFor(tag).length > 0, 180_000, 2_000)
      // The write made while it was off reaches the desktop, exactly once.
      await waitFor('the offline write on the desktop', async () =>
        (await channelMessages(peer, t.seed.channelId)).some((m) => m.text === offlineText), 180_000, 2_000)

      // The socket held through the outage still delivers: a cloud write after
      // the reconnect arrives without a reload.
      const afterText = uniq('after the reconnect')
      const marked = socket.mark()
      expect((await send(t.api, 'POST', conv, { text: afterText })).status).toBe(201)
      await socket.waitForEvent((e) => e.type === 'message.created' && e.message?.text === afterText, {
        label: 'a message on the socket held across the outage',
        since: marked,
        timeoutMs: 15_000,
      })

      // Nothing twice: each text is one message on both sides.
      await new Promise((r) => setTimeout(r, 3_000))
      for (const text of [offlineText, afterText]) {
        const inCloud = (await channelMessages(t, t.seed.channelId)).filter((m) => m.text === text)
        const onDesktop = (await channelMessages(peer, t.seed.channelId)).filter((m) => m.text === text)
        expect(inCloud.length, `${text} in the cloud`).toBe(1)
        expect(onDesktop.length, `${text} on the desktop`).toBe(1)
      }
    } finally {
      socket.close()
    }
  }, 600_000)
})
