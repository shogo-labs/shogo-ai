// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A first-page load is authoritative for its own chat, not for every chat that
 * shares the collection (SHO-328).
 *
 * The collection is a singleton in the root store, and several callers keep
 * chats in it (the `/chat-messages?limit=1` tail probe, a page that holds more
 * than one session). `loadPage({ sessionId }, offset 0)` used to delete every
 * row in the map, so loading chat B emptied chat A between A's fetch and the
 * paint that reads `all` — one of the ways a reply vanished from the screen at
 * turn end.
 */
import { expect, test } from "bun:test"
import { ChatMessageCollection } from "../chat-message.collection"

const row = (id: string, sessionId: string, content: string) => ({
  id,
  sessionId,
  role: "user" as const,
  content,
})

function collectionReturning(items: any[]) {
  return ChatMessageCollection.create(
    { items: {} },
    {
      http: {
        get: () =>
          Promise.resolve({
            data: { ok: true, items, total: items.length },
          }),
      },
    } as never,
  )
}

test("a session's first page leaves another session's rows alone", async () => {
  const collection = collectionReturning([row("b1", "session-b", "hello from b")])
  collection.addItem(row("a1", "session-a", "hello from a"))

  await collection.loadPage({ sessionId: "session-b" }, { limit: 50, offset: 0 })

  expect(collection.all.map((message: any) => message.id).sort()).toEqual(["a1", "b1"])
})

test("a session's first page still drops its own rows the page no longer has", async () => {
  const collection = collectionReturning([row("a2", "session-a", "the only row left")])
  collection.addItem(row("a1", "session-a", "deleted while we were away"))
  collection.addItem(row("b1", "session-b", "another chat"))

  await collection.loadPage({ sessionId: "session-a" }, { limit: 50, offset: 0 })

  expect(collection.all.map((message: any) => message.id).sort()).toEqual(["a2", "b1"])
})

test("an unfiltered first page is still authoritative for the whole collection", async () => {
  const collection = collectionReturning([row("a2", "session-a", "current")])
  collection.addItem(row("a1", "session-a", "stale"))
  collection.addItem(row("b1", "session-b", "stale"))

  await collection.loadPage(undefined, { limit: 50, offset: 0 })

  expect(collection.all.map((message: any) => message.id)).toEqual(["a2"])
})
