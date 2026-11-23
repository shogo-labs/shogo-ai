// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-483 QA round 2: the batched quote-card read was added to `teamChatApi()`
 * as a second `messages` key, which silently replaced the transcript read
 * `messages(conversationId, opts)`. Every channel, thread and DM then called
 * `conversationId.join(',')` and rendered "e.join is not a function" instead
 * of its messages. Both reads must exist and hit their own routes.
 *
 * Run: cd apps/mobile && bun test lib/__tests__/team-chat-api-messages.test.ts
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"

const requested: string[] = []
const fakeClient = {
  async get(url: string) {
    requested.push(url)
    if (url.startsWith("/api/conversation-messages?")) {
      return { data: { messages: [{ id: "m1" }], missing: ["m2"] } }
    }
    return { data: { messages: [{ id: "m9" }], hasMore: false } }
  },
}

const domain = await import("@shogo/shared-app/domain")
mock.module("@shogo/shared-app/domain", () => ({ ...domain, getSDKHttpClient: () => fakeClient }))

const { teamChatApi } = await import("../team-chat-api")

describe("teamChatApi message reads", () => {
  beforeEach(() => {
    requested.length = 0
  })

  test("messages(conversationId) still reads the conversation's transcript", async () => {
    const page = await teamChatApi().messages("conv-1", { limit: 30 })
    expect(requested).toEqual(["/api/conversations/conv-1/messages?limit=30"])
    expect(page.messages.map((m) => m.id)).toEqual(["m9"])
  })

  test("messagesById(ids) is the batched quote-card read", async () => {
    const result = await teamChatApi().messagesById(["m1", "m2"])
    expect(requested).toEqual(["/api/conversation-messages?ids=m1%2Cm2"])
    expect(result.missing).toEqual(["m2"])
  })
})
