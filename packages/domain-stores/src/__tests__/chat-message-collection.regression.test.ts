// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test } from "bun:test"
import { ChatMessageCollection } from "../chat-message.collection"

const sessionAMessage = {
  id: "message-a",
  sessionId: "session-a",
  role: "user" as const,
  content: "Message from session A",
}

const sessionBMessage = {
  id: "message-b",
  sessionId: "session-b",
  role: "user" as const,
  content: "Message from session B",
}

test("filtered loads replace messages from the previous chat session", async () => {
  const collection = ChatMessageCollection.create(
    { items: {} },
    {
      http: {
        get: (url: string) =>
          url.includes("sessionId=session-a")
            ? Promise.resolve({ data: { ok: true, items: [sessionAMessage] } })
            : Promise.resolve({ data: { ok: true, items: [sessionBMessage] } }),
      },
    } as never,
  )

  await collection.loadAll({ sessionId: "session-a" })
  await collection.loadAll({ sessionId: "session-b" })

  expect(collection.all.map((message) => message.id)).toEqual(["message-b"])
})
