// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { countUnread, isConversationUnread, unreadConversations } from "../team-chat-counts"
import type { ConversationSummary } from "../team-chat-api"

function conv(over: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: "c",
    kind: "public",
    unreadCount: 0,
    mentionCount: 0,
    muted: false,
    archivedAt: null,
    joined: true,
    ...over,
  } as ConversationSummary
}

describe("countUnread", () => {
  test("adds DM unread and channel mentions, skipping muted and archived conversations", () => {
    const list = [
      conv({ id: "a", kind: "dm", unreadCount: 3 }),
      conv({ id: "b", kind: "group_dm", unreadCount: 2 }),
      conv({ id: "c", kind: "public", mentionCount: 4 }),
      conv({ id: "d", kind: "public", mentionCount: 9, muted: true }),
      conv({ id: "e", kind: "dm", unreadCount: 7, archivedAt: "2026-01-01T00:00:00Z" }),
    ]
    const counts = countUnread(list, { unread: 0, unreadThreads: 0 })
    expect(counts.dms).toBe(5)
    expect(counts.channels).toBe(4)
  })

  test("counts every unread inbox item by default", () => {
    const counts = countUnread([], { unread: 5, unreadThreads: 2 })
    expect(counts.inbox).toBe(5)
    expect(counts.activityDot).toBe(false)
  })

  test("with thread replies kept out of the number, a thread-only unread shows as a dot", () => {
    const counts = countUnread([], { unread: 2, unreadThreads: 2 }, false)
    expect(counts.inbox).toBe(0)
    expect(counts.activityDot).toBe(true)
  })

  test("with thread replies kept out of the number, other unread items still count", () => {
    const counts = countUnread([], { unread: 5, unreadThreads: 2 }, false)
    expect(counts.inbox).toBe(3)
    expect(counts.activityDot).toBe(false)
  })

  test("no dot when nothing is unread", () => {
    const counts = countUnread([], { unread: 0, unreadThreads: 0 }, false)
    expect(counts.inbox).toBe(0)
    expect(counts.activityDot).toBe(false)
  })

  test("never goes negative when the thread count is ahead of the total", () => {
    const counts = countUnread([], { unread: 1, unreadThreads: 4 }, false)
    expect(counts.inbox).toBe(0)
    expect(counts.activityDot).toBe(true)
  })
})

describe("isConversationUnread", () => {
  test("a channel with unread messages but no mention is still unread", () => {
    expect(isConversationUnread(conv({ unreadCount: 3, mentionCount: 0 }))).toBe(true)
  })

  test("nothing unread is not unread", () => {
    expect(isConversationUnread(conv({ unreadCount: 0 }))).toBe(false)
  })

  test("muted hides it even with unread messages", () => {
    expect(isConversationUnread(conv({ unreadCount: 5, muted: true }))).toBe(false)
  })

  test("archived hides it even with unread messages", () => {
    expect(isConversationUnread(conv({ unreadCount: 5, archivedAt: "2026-01-01T00:00:00Z" }))).toBe(false)
  })

  test("not joined hides a regular channel", () => {
    expect(isConversationUnread(conv({ unreadCount: 5, joined: false }))).toBe(false)
  })

  test("#activity counts even when not joined, like the Channels panel treats it", () => {
    expect(isConversationUnread(conv({ kind: "activity", unreadCount: 2, joined: false }))).toBe(true)
  })

  test("a DM with unread but no mention is still unread", () => {
    expect(isConversationUnread(conv({ kind: "dm", unreadCount: 1, mentionCount: 0 }))).toBe(true)
  })
})

describe("unreadConversations", () => {
  test("keeps only joined, unmuted, unarchived conversations with something unread", () => {
    const list = [
      conv({ id: "a", unreadCount: 2 }),
      conv({ id: "b", unreadCount: 0 }),
      conv({ id: "c", unreadCount: 4, muted: true }),
      conv({ id: "d", unreadCount: 4, archivedAt: "2026-01-01T00:00:00Z" }),
      conv({ id: "e", kind: "dm", unreadCount: 1 }),
    ]
    expect(unreadConversations(list).map((c) => c.id)).toEqual(["a", "e"])
  })

  test("an empty list stays empty", () => {
    expect(unreadConversations([])).toEqual([])
  })
})
