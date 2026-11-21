// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 3 — team chat in a remote workspace.
 *
 * The same scenario three ways (cloud workspace · the desktop's own API · the
 * hosted workspace opened from the cloud), each assertion made on the realtime
 * socket, opened before the action, with no GET in between. The stored state is
 * read once at the end.
 *
 * Needs `CHANNELS_TEST_PG_URL` and `TEST_REDIS_URL`/`REDIS_URL` (the cloud runs
 * on Postgres + Redis, the desktop on its own SQLite file). Skips without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  TARGET_NAMES,
  TURN_TARGETS,
  channelMessages,
  openLive,
  openSocket,
  openStream,
  read,
  send,
  startRemoteWorkspace,
  uniq,
  type Live,
  type RemoteWorkspace,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let ws: RemoteWorkspace
const target = (name: (typeof TARGET_NAMES)[number]): Target => ws.target(name)

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

/** A live socket for this target, closed after the test even if it throws. */
async function live(target: Target): Promise<{ live: Live; done: () => void }> {
  const opened = await openLive({ ...target, peer: undefined })
  return { live: opened.live, done: () => opened.live.close() }
}

describeIfInfra('remote workspace · team chat', () => {
  test('every target serves the realtime WebSocket, not just the SSE fallback', async () => {
    for (const name of TARGET_NAMES) {
      const opened = await openLive(target(name))
      try {
        expect(opened.live.transport, `${name}: ${opened.live.upgradeError ?? ''}`).toBe('ws')
      } finally {
        opened.live.close()
        opened.peer?.close()
      }
    }
  }, 60_000)

  for (const name of TARGET_NAMES) {
    describe(name, () => {
      test('a channel created here is announced live and reads back', async () => {
        const t = target(name)
        const { live: socket, done } = await live(t)
        try {
          const channelName = uniq('live channel').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
          const marked = socket.mark()
          const created = await send(t.api, 'POST', `/api/workspaces/${encodeURIComponent(t.workspaceId)}/conversations`, {
            name: channelName,
            kind: 'public',
          })
          expect(created.status, JSON.stringify(created.data)).toBe(201)
          const channelId = created.data?.conversation?.id

          await socket.waitForEvent(
            (e) => e.type === 'conversation.created' && e.conversation?.id === channelId,
            { label: 'conversation.created', since: marked },
          )

          const listed = await read(t, `/api/workspaces/${encodeURIComponent(t.workspaceId)}/conversations`)
          const rows: any[] = listed.data?.conversations ?? []
          expect(rows.map((c) => c.id)).toContain(channelId)
        } finally {
          done()
        }
      }, 60_000)

      test('a message posted here arrives on the live socket with no GET', async () => {
        const t = target(name)
        const { live: socket, done } = await live(t)
        try {
          const text = uniq('posted live')
          const marked = socket.mark()
          const posted = await send(t.api, 'POST', `/api/conversations/${encodeURIComponent(t.seed.channelId)}/messages`, {
            text,
          })
          expect(posted.status, JSON.stringify(posted.data)).toBe(201)
          const messageId = posted.data?.message?.id

          const arrived = await socket.waitForEvent(
            (e) => e.type === 'message.created' && e.message?.id === messageId,
            { label: 'message.created', since: marked },
          )
          expect(arrived.event.message.text).toBe(text)

          const stored = await channelMessages(t, t.seed.channelId)
          expect(stored.map((m) => m.text)).toContain(text)
        } finally {
          done()
        }
      }, 60_000)

      test('a thread reply, a reaction, an edit and a delete all arrive live', async () => {
        const t = target(name)
        const { live: socket, done } = await live(t)
        const conv = `/api/conversations/${encodeURIComponent(t.seed.channelId)}`
        try {
          // Thread reply.
          let marked = socket.mark()
          const replyText = uniq('thread reply')
          const reply = await send(t.api, 'POST', `${conv}/messages`, { text: replyText, threadRootId: t.seed.threadRootId })
          expect(reply.status, JSON.stringify(reply.data)).toBe(201)
          await socket.waitForEvent(
            (e) => e.type === 'message.created' && e.message?.text === replyText,
            { label: 'the thread reply', since: marked },
          )

          // Reaction on it.
          marked = socket.mark()
          const reacted = await send(t.api, 'POST', `/api/conversation-messages/${encodeURIComponent(reply.data.message.id)}/reactions`, {
            emoji: '🎉',
          })
          expect(reacted.status, JSON.stringify(reacted.data)).toBeLessThan(300)
          await socket.waitForEvent(
            (e) => e.type === 'reaction.changed' && e.messageId === reply.data.message.id,
            { label: 'reaction.changed', since: marked },
          )

          // Edit.
          marked = socket.mark()
          const editedText = `${replyText} (edited)`
          const edited = await send(t.api, 'PATCH', `/api/conversation-messages/${encodeURIComponent(reply.data.message.id)}`, {
            text: editedText,
          })
          expect(edited.status, JSON.stringify(edited.data)).toBeLessThan(300)
          await socket.waitForEvent(
            (e) => e.type === 'message.updated' && e.message?.id === reply.data.message.id && e.message?.text === editedText,
            { label: 'message.updated (edit)', since: marked },
          )

          // Delete: a soft delete, announced as an update carrying `deletedAt`.
          marked = socket.mark()
          const deleted = await send(t.api, 'DELETE', `/api/conversation-messages/${encodeURIComponent(reply.data.message.id)}`)
          expect(deleted.status, JSON.stringify(deleted.data)).toBeLessThan(300)
          await socket.waitForEvent(
            (e) => e.type === 'message.updated' && e.message?.id === reply.data.message.id && !!e.message?.deletedAt,
            { label: 'message.updated (delete)', since: marked },
          )
        } finally {
          done()
        }
      }, 90_000)

      test('the typing indicator arrives live', async () => {
        const t = target(name)
        // The WebSocket drops a client's own typing frame (a page shows its own
        // cursor locally), so this check reads the read-only stream, where the
        // same published event is not filtered.
        const stream = await openStream(t)
        const socket = await openSocket(t)
        try {
          // Precondition: this stream really is live (a channel write reaches
          // it), so a typing failure names the typing frame and not the stream.
          let marked = stream.mark()
          const probeText = uniq('stream is live')
          expect(
            (await send(t.api, 'POST', `/api/conversations/${encodeURIComponent(t.seed.channelId)}/messages`, { text: probeText })).status,
          ).toBe(201)
          await stream.waitForEvent((e) => e.type === 'message.created' && e.message?.text === probeText, {
            label: 'a channel message on the read-only stream',
            since: marked,
          })

          marked = stream.mark()
          socket.send({ type: 'typing', conversationId: t.seed.channelId })
          const arrived = await stream.waitForEvent(
            (e) => e.type === 'typing' && e.conversationId === t.seed.channelId,
            { label: 'typing', since: marked },
          )
          expect(arrived.event.name).toBeTruthy()
        } finally {
          socket.close()
          stream.close()
        }
      }, 60_000)

      test('reading a channel updates the unread count live', async () => {
        const t = target(name)
        const { live: socket, done } = await live(t)
        try {
          const text = uniq('unread')
          expect((await send(t.api, 'POST', `/api/conversations/${encodeURIComponent(t.seed.channelId)}/messages`, { text })).status)
            .toBe(201)

          const marked = socket.mark()
          const read = await send(t.api, 'POST', `/api/conversations/${encodeURIComponent(t.seed.channelId)}/read`, {})
          expect(read.status, JSON.stringify(read.data)).toBeLessThan(300)
          const arrived = await socket.waitForEvent(
            (e) => e.type === 'read' && e.conversationId === t.seed.channelId,
            { label: 'read', since: marked },
          )
          expect(arrived.event.unreadCount).toBe(0)
        } finally {
          done()
        }
      }, 60_000)

      test('the channel doc reads and saves live', async () => {
        const t = target(name)
        const { live: socket, done } = await live(t)
        const conv = `/api/conversations/${encodeURIComponent(t.seed.channelId)}`
        try {
          const before = await read(t, `${conv}/doc`)
          expect(before.status, before.error).toBeLessThan(300)
          const version = before.data?.doc?.version ?? 0

          const title = uniq('doc title')
          const marked = socket.mark()
          const saved = await send(t.api, 'PUT', `${conv}/doc`, {
            title,
            content: `# ${title}\n\nwritten from the ${name} side.`,
            baseVersion: version,
          })
          expect(saved.status, JSON.stringify(saved.data)).toBe(200)
          expect(saved.data?.doc?.title, JSON.stringify(saved.data)).toBe(title)

          await socket.waitForEvent((e) => e.type === 'doc.updated' && e.conversationId === t.seed.channelId, {
            label: 'doc.updated',
            since: marked,
          })
          const after = await read(t, `${conv}/doc`)
          expect(after.data?.doc?.title).toBe(title)
          expect(after.data?.doc?.content).toContain(`written from the ${name} side.`)
        } finally {
          done()
        }
      }, 60_000)

      // An agent reply is a model turn: see TURN_TARGETS in harness.ts.
      if (TURN_TARGETS.includes(name)) test('an @agent mention in a channel is answered live', async () => {
        const t = target(name)
        const opened = await openLive(t)
        const socket = opened.live
        try {
          const text = `roll call ${uniq('mention')}`
          const posted = await send(
            t.api,
            'POST',
            `/api/conversations/${encodeURIComponent(t.seed.channelId)}/messages`,
            { text: `@${t.seed.projectNames[0]} ${text}` },
          )
          expect(posted.status, JSON.stringify(posted.data)).toBe(201)

          // Producing the reply is a model turn (on the cloud, or on the
          // desktop through the tunnel), so the budget covers production; the
          // assertion is that the answer itself arrives without a GET, on the
          // socket. An empty "running" placeholder does not count (it is not
          // something a person can read), and the text may land as the first
          // `message.created` or as the `message.updated` that fills it in.
          const arrived = await socket.waitForEvent(
            (e) =>
              (e.type === 'message.created' || e.type === 'message.updated') &&
              e.message?.authorType === 'agent' &&
              typeof e.message?.text === 'string' &&
              e.message.text.trim().length > 0,
            { label: 'the agent reply', timeoutMs: 60_000 },
          )
          expect(arrived.event.message.authorType).toBe('agent')
        } finally {
          socket.close()
          opened.peer?.close()
        }
      }, 120_000)
    })
  }

  // Both directions: a write made on the computer, seen live in the cloud.
  // SHO-486 §1 fixed this on main (#2139): the machine-sync insert point now
  // publishes the bus event, so a message written on the desktop reaches a
  // cloud socket with no refetch. Asserted as a requirement — it was measured
  // at 528 ms when the marker flipped, and it goes red if the insert point
  // ever stops publishing again.
  test('hosted · a message and an agent reply written on the desktop arrive live in the cloud', async () => {
    const t = target('hosted')
    const peer = t.peer!
    const opened = await openLive(t)
    try {
      // A plain message written on the computer.
      const deskText = uniq('from the desktop')
      const fromDesktop = await send(peer.api, 'POST', `/api/conversations/${encodeURIComponent(t.seed.channelId)}/messages`, {
        text: deskText,
      })
      expect(fromDesktop.status, JSON.stringify(fromDesktop.data)).toBeLessThan(300)

      await opened.live.waitForEvent(
        (e) => e.type === 'message.created' && e.message?.text === deskText,
        { label: 'the desktop message in the cloud' },
      )

      // An agent reply produced on the computer (its own socket sees it first;
      // the cloud must hear about it within the budget of that write).
      const peerLive = opened.peer!
      const mention = `@${t.seed.projectNames[0]} ${uniq('desktop mention')}`
      expect(
        (await send(peer.api, 'POST', `/api/conversations/${encodeURIComponent(t.seed.channelId)}/messages`, { text: mention })).status,
      ).toBe(201)
      const onDesktop = await peerLive.waitForEvent(
        (e) => e.type === 'message.created' && e.message?.authorType === 'agent',
        { label: 'the agent reply on the desktop', timeoutMs: 90_000 },
      )
      await opened.live.waitForEvent((e) => e.type === 'message.created' && e.message?.id === onDesktop.event.message.id, {
        label: 'the same reply in the cloud',
        since: onDesktop.at,
      })
    } finally {
      opened.live.close()
      opened.peer?.close()
    }
  }, 180_000)
})
