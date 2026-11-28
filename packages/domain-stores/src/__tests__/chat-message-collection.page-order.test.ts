// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A paged load asks for newest-first and does not trust the order it gets back
 * (SHO-328).
 *
 * In local mode there is no `beforeList` on the chat-message hooks, so
 * `/api/chat-messages` applies no default ORDER BY and SQLite answers in
 * primary-key order. `loadPage` then held an arbitrary 50-row slice as "the
 * newest 50": today's prompt and reply were missing from it, so the turn-end
 * paint compared the screen against a page that could not contain the reply it
 * was looking at. The client now asks for `orderBy=createdAt:desc` itself and
 * sorts the page before it lands in the map.
 */
import { expect, test } from "bun:test"
import { ChatMessageCollection } from "../chat-message.collection"

const row = (id: string, createdAt: string) => ({
  id,
  sessionId: "session-a",
  role: "user" as const,
  content: `content of ${id}`,
  createdAt,
})

function collectionServing(items: any[]) {
  const urls: string[] = []
  const collection = ChatMessageCollection.create(
    { items: {} },
    {
      http: {
        get: (url: string) => {
          urls.push(url)
          return Promise.resolve({
            data: { ok: true, items, total: items.length },
          })
        },
      },
    } as never,
  )
  return { collection, urls }
}

test("the first page asks for newest-first instead of trusting the server", async () => {
  const { collection, urls } = collectionServing([])

  await collection.loadPage({ sessionId: "session-a" }, { limit: 50, offset: 0 })

  const params = new URL(urls[0], "http://local.test").searchParams
  expect(params.get("orderBy")).toBe("createdAt:desc")
  expect(params.get("sessionId")).toBe("session-a")
  expect(params.get("limit")).toBe("50")
})

test("a caller's own order wins over the default", async () => {
  const { collection, urls } = collectionServing([])

  await collection.loadPage(
    { sessionId: "session-a", orderBy: "createdAt:asc" },
    { limit: 50, offset: 0 },
  )

  const params = new URL(urls[0], "http://local.test").searchParams
  expect(params.getAll("orderBy")).toEqual(["createdAt:asc"])
})

test("a page that arrives in id order lands newest-first", async () => {
  // ids ascending, like SQLite's primary-key order, with the dates mixed — the
  // shape Russell's probe logged for chat 8a1c5acc.
  const { collection } = collectionServing([
    row("02aef959", "2026-11-25T08:37:00.000Z"),
    row("0555feea", "2026-11-25T19:41:00.000Z"),
    row("0QADDnG1", "2026-11-23T10:02:00.000Z"),
    row("2b58e4b0", "2026-11-28T13:49:00.000Z"),
  ])

  await collection.loadPage({ sessionId: "session-a" }, { limit: 50, offset: 0 })

  expect(collection.all.map((message) => message.id)).toEqual([
    "2b58e4b0",
    "0555feea",
    "02aef959",
    "0QADDnG1",
  ])
})

test("a later page does not disturb the order already on screen", async () => {
  const { collection } = collectionServing([
    row("newest", "2026-11-28T13:49:00.000Z"),
    row("older", "2026-11-27T09:00:00.000Z"),
  ])
  await collection.loadPage({ sessionId: "session-a" }, { limit: 2, offset: 0 })

  const { collection: older } = collectionServing([
    row("oldest", "2026-11-20T09:00:00.000Z"),
  ])
  await older.loadPage({ sessionId: "session-a" }, { limit: 1, offset: 2 })

  expect(older.all.map((message) => message.id)).toEqual(["oldest"])
  expect(collection.all.map((message) => message.id)).toEqual(["newest", "older"])
})
