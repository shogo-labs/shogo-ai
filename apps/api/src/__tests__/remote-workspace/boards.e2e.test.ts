// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 5 — boards and cards in a remote workspace.
 *
 * A board is a channel's board, and every change to it publishes `board.changed`
 * on the workspace socket. The checks: create, move, comment and assign from one
 * side, live on the socket and stored; the same from the computer side, live in
 * the cloud; and two edits to one card resolve last-writer-wins (the rule the
 * SHO-285 acceptance test already asserts, kept here for the hosted target).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  TARGET_NAMES,
  openLive,
  read,
  send,
  startRemoteWorkspace,
  uniq,
  waitForSync,
  type RemoteWorkspace,
  type Side,
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

async function card(side: Side & { api: any }, itemId: string): Promise<any> {
  const res = await read(side, `/api/work-items/${encodeURIComponent(itemId)}`)
  return res.data?.item ?? res.data?.workItem ?? res.data
}

describeIfInfra('remote workspace · boards', () => {
  for (const name of TARGET_NAMES) {
    describe(name, () => {
      test('a card created, moved, commented on and assigned here is live and stored', async () => {
        const t = target(name)
        const { live: socket } = await openLive({ ...t, peer: undefined })
        try {
          // Create.
          let marked = socket.mark()
          const title = uniq('card')
          const created = await send(t.api, 'POST', `/api/boards/${encodeURIComponent(t.seed.boardId)}/items`, { title })
          expect(created.status, JSON.stringify(created.data)).toBeLessThan(300)
          const itemId = created.data?.item?.id ?? created.data?.workItem?.id ?? created.data?.id
          expect(itemId, JSON.stringify(created.data)).toBeTruthy()
          await socket.waitForEvent((e) => e.type === 'board.changed' && e.itemId === itemId && e.action === 'item.created', {
            label: 'board.changed (item.created)',
            since: marked,
          })

          // Move to a column other than the one it was created in: a move onto
          // the card's own column is a no-op and publishes nothing.
          const board = await read(t, `/api/boards/${encodeURIComponent(t.seed.boardId)}`)
          const columns: any[] = board.data?.columns ?? board.data?.board?.columns ?? []
          expect(columns.length, JSON.stringify(board.data).slice(0, 300)).toBeGreaterThan(1)
          const before = await card(t as any, itemId)
          const destination = columns.find((column: any) => column.id !== before?.columnId) ?? columns[1]
          marked = socket.mark()
          const moved = await send(t.api, 'POST', `/api/work-items/${encodeURIComponent(itemId)}/move`, {
            // The move route reads `column` (moveInput), not `columnId`.
            column: destination.id,
          })
          expect(moved.status, JSON.stringify(moved.data)).toBeLessThan(300)
          // Within one board a column change is published as `item.reordered`
          // (a cross-board move is the one that says `item.moved`).
          await socket.waitForEvent(
            (e) =>
              e.type === 'board.changed' &&
              e.itemId === itemId &&
              (e.action === 'item.moved' || e.action === 'item.reordered'),
            {
              label: 'board.changed (item.moved)',
              since: marked,
            },
          )
          expect((await card(t as any, itemId))?.columnId).toBe(destination.id)

          // Comment: it lands as a message in the card's thread, so the live
          // event is `message.created`, not a `board.changed`.
          marked = socket.mark()
          const comment = uniq('comment')
          const commented = await send(t.api, 'POST', `/api/work-items/${encodeURIComponent(itemId)}/comments`, { text: comment })
          expect(commented.status, JSON.stringify(commented.data)).toBe(201)
          await socket.waitForEvent(
            (e) => e.type === 'message.created' && JSON.stringify(e.message ?? {}).includes(comment),
            { label: 'message.created (the card comment)', since: marked },
          )

          // Assign (a card edit, announced as item.updated).
          marked = socket.mark()
          const assigned = await send(t.api, 'PATCH', `/api/work-items/${encodeURIComponent(itemId)}`, {
            assigneeUserId: ws.cloudUserId,
          })
          expect(assigned.status, JSON.stringify(assigned.data)).toBeLessThan(300)
          await socket.waitForEvent((e) => e.type === 'board.changed' && e.itemId === itemId && e.action === 'item.updated', {
            label: 'board.changed (item.updated)',
            since: marked,
          })
        } finally {
          socket.close()
        }
      }, 120_000)

      test('two edits to one card: the later one wins everywhere', async () => {
        const t = target(name)
        const created = await send(t.api, 'POST', `/api/boards/${encodeURIComponent(t.seed.boardId)}/items`, {
          title: uniq('race card'),
        })
        const itemId = created.data?.item?.id ?? created.data?.id
        expect(itemId).toBeTruthy()

        const first = uniq('first edit')
        const second = uniq('second edit')
        expect((await send(t.api, 'PATCH', `/api/work-items/${encodeURIComponent(itemId)}`, { title: first })).status).toBeLessThan(300)
        await new Promise((r) => setTimeout(r, 1_100))
        expect((await send(t.api, 'PATCH', `/api/work-items/${encodeURIComponent(itemId)}`, { title: second })).status).toBeLessThan(300)

        expect((await card(t as any, itemId))?.title).toBe(second)
        if (t.peer) {
          await waitForSync(ws.machine, 'the later edit on the desktop', async () =>
            (await card({ ...t.peer!, workspaceId: t.peer!.workspaceId } as any, itemId))?.title === second, 60_000, 1_000)
        }
      }, 120_000)
    })
  }

  // SHO-486 §1: a board change made on the computer reaches Postgres through
  // machine sync, and the sync insert point publishes nothing, so the cloud
  // socket never hears it. Fails on main; flips to `test` with SHO-486.
  test.failing('hosted · a card the desktop moves arrives live in the cloud [SHO-486]', async () => {
    const t = target('hosted')
    const peer = t.peer!
    const board = await read(peer, `/api/boards/${encodeURIComponent(t.seed.boardId)}`)
    const columns: any[] = board.data?.columns ?? board.data?.board?.columns ?? []
    const created = await send(peer.api, 'POST', `/api/boards/${encodeURIComponent(t.seed.boardId)}/items`, {
      title: uniq('desktop card'),
    })
    const itemId = created.data?.item?.id ?? created.data?.id
    expect(itemId).toBeTruthy()

    const { live: cloud } = await openLive({ ...t, peer: undefined })
    try {
      const marked = cloud.mark()
      const moved = await send(peer.api, 'POST', `/api/work-items/${encodeURIComponent(itemId)}/move`, { columnId: columns[1].id })
      expect(moved.status, JSON.stringify(moved.data)).toBeLessThan(300)
      await cloud.waitForEvent((e) => e.type === 'board.changed' && e.itemId === itemId, {
        label: 'board.changed from the desktop',
        since: marked,
      })
    } finally {
      cloud.close()
    }
  }, 120_000)
})
