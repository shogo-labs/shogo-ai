// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-52: pressing a chat chip opens the chat in the chat's own workspace.
 *
 * A chip tagged from another workspace must switch to it first — the chat
 * screens read the active workspace, and a send from the wrong one is rejected
 * server-side (`session_not_in_workspace`). The press also has to survive the
 * source turn finishing seconds later: that turn's clamp
 * (`shouldRestoreChatWorkspace`) must not put the app back in the workspace the
 * person just left.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render } from "@testing-library/react"
import React, { createElement, forwardRef } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

// react-native's `Text` in the shared mock drops `onPress`; map it to a DOM
// click so a chip press can be driven from the test. `Platform.OS: "ios"` keeps
// `openInWorkspace` on its native branch (persist + push) instead of a full
// `window.location` navigation.
const PressableText = forwardRef(function PressableText(props: any, ref: any) {
  const { onPress, children, ...rest } = props
  return createElement("span", { ...rest, ref, onClick: onPress }, children)
})

mock.module("react-native", () =>
  createReactNativeMock({ Text: PressableText, Platform: { OS: "ios" } }),
)

const push = mock((..._args: any[]) => {})
mock.module("expo-router", () => ({ useRouter: () => ({ push }) }))

// better-auth's expo client pings on construction; the chip only uses
// `$fetch` for title lookups, which these tests supply directly.
mock.module("../../../lib/auth-client", () => ({
  authClient: { $fetch: async () => ({ data: { chats: [] } }) },
}))

const projectCollection = { clear: mock(() => {}), loadAll: mock(async () => {}) }
mock.module("../../../contexts/domain", () => ({
  useProjectCollection: () => projectCollection,
  useWorkspaceCollection: () => ({ all: [] }),
}))

// Filled in below, after the mocked react-native is in place: the store and the
// switch helper must not load the real native modules.
const store = {
  get: (): string | null => null,
  set: (_id: string) => {},
}
mock.module("../../../hooks/useActiveWorkspace", () => ({
  useActiveWorkspace: () => ({ id: store.get() }),
}))

const storeModule = await import("../../../lib/workspace-store")
const switchModule = await import("../../../lib/switch-workspace")
store.get = storeModule.getActiveWorkspaceId
store.set = storeModule.setActiveWorkspaceId
const getActiveWorkspaceId = storeModule.getActiveWorkspaceId
const clearActiveWorkspaceId = storeModule.clearActiveWorkspaceId
const setActiveWorkspaceId = storeModule.setActiveWorkspaceId
const shouldRestoreChatWorkspace = switchModule.shouldRestoreChatWorkspace
const adoptChatWorkspace = switchModule.adoptChatWorkspace

const { ChatMentionChip, chatMentionHref, chatMentionSince, ChatMentionText } = await import(
  "../ChatMentionChip"
)
const { chatMentionMetaFor } = await import("../../../lib/chat-mention-meta")

const realFetch = globalThis.fetch

beforeEach(() => {
  // Each test starts from a clean store: the active id and any switch intent
  // outlive a test otherwise, and the intent would make the next test look
  // like a stale writer for a workspace an earlier test switched away from.
  clearActiveWorkspaceId()
  setActiveWorkspaceId("ws-a")
  push.mockClear()
  projectCollection.clear.mockClear()
  projectCollection.loadAll.mockClear()
})

afterEach(() => {
  globalThis.fetch = realFetch
  cleanup()
})

describe("chat mention chip", () => {
  test("a workspace chat carries its session", () => {
    expect(chatMentionHref({ id: "chat-b", projectId: null, workspaceId: "ws-b" })).toBe(
      "/(app)/agent?chatSessionId=chat-b",
    )
  })

  test("a project chat opens its project surface with that session", () => {
    expect(
      chatMentionHref({ id: "chat-b", projectId: "proj-2", workspaceId: "ws-b" }),
    ).toBe("/(app)/projects/proj-2?chatSessionId=chat-b")
  })

  test("a chat of unknown workspace opens on the session alone", () => {
    expect(chatMentionHref({ id: "chat-b", projectId: null })).toBe(
      "/(app)/agent?chatSessionId=chat-b",
    )
  })

  test("pressing a chip for another workspace switches to it", () => {
    const { getByText } = render(
      <ChatMentionChip
        id="chat-b"
        meta={{
          id: "chat-b",
          title: "Deploy notes",
          projectId: null,
          workspaceId: "ws-b",
          workspaceName: "Other team",
        }}
      />,
    )

    fireEvent.click(getByText(/@Deploy notes/))

    expect(getActiveWorkspaceId()).toBe("ws-b")
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toBe("/(app)/agent?chatSessionId=chat-b")
    expect(projectCollection.clear).toHaveBeenCalled()
  })

  test("a user message anchors its tags to when it was sent", () => {
    // The newest user message is painted by `EditableUserMessage`, not the
    // `userBubble` variant — keying the window on the variant left a fresh tag
    // with no delivery state at all (SHO-52 round 5).
    expect(chatMentionSince({ role: "user", createdAt: 1_700_000_000_000 })).toBe(
      1_700_000_000_000,
    )
    expect(chatMentionSince({ role: "assistant", createdAt: 1_700_000_000_000 })).toBeNull()
    expect(chatMentionSince({ role: "user" })).toBeNull()
  })

  test("a URL session in another workspace persists the target id", async () => {
    // What a cold boot at `/agent?chatSessionId=chat-b` does: the screen has no
    // workspace in the URL, so it asks who owns the session and adopts it.
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          chats: [
            {
              id: "chat-b",
              title: "Deploy notes",
              projectId: null,
              workspaceId: "ws-b",
              workspaceName: "Other team",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    ) as any

    const meta = await chatMentionMetaFor("chat-b")
    expect(meta?.workspaceId).toBe("ws-b")

    const adopted = adoptChatWorkspace(meta?.workspaceId, getActiveWorkspaceId(), projectCollection)

    expect(adopted).toBe(true)
    expect(getActiveWorkspaceId()).toBe("ws-b")
    expect(projectCollection.loadAll).toHaveBeenCalledWith({ workspaceId: "ws-b" })
  })

  test("a URL session already in the active workspace is left alone", async () => {
    setActiveWorkspaceId("ws-a")

    expect(adoptChatWorkspace("ws-a", getActiveWorkspaceId(), projectCollection)).toBe(false)
    expect(adoptChatWorkspace(null, getActiveWorkspaceId(), projectCollection)).toBe(false)
    expect(getActiveWorkspaceId()).toBe("ws-a")
    expect(projectCollection.loadAll).not.toHaveBeenCalled()
  })

  test("pressing a chip in the active workspace stays put", () => {
    const { getByText } = render(
      <ChatMentionChip
        id="chat-a"
        meta={{ id: "chat-a", title: "Billing bug", projectId: null, workspaceId: "ws-a" }}
      />,
    )

    fireEvent.click(getByText(/@Billing bug/))

    expect(getActiveWorkspaceId()).toBe("ws-a")
    expect(push).toHaveBeenCalledTimes(1)
    expect(projectCollection.clear).not.toHaveBeenCalled()
  })

  test("the source turn finishing does not undo the switch", () => {
    const { getByText } = render(
      <ChatMentionChip
        id="chat-b"
        meta={{ id: "chat-b", title: "Deploy notes", projectId: null, workspaceId: "ws-b" }}
      />,
    )

    fireEvent.click(getByText(/@Deploy notes/))
    expect(getActiveWorkspaceId()).toBe("ws-b")

    // The source chat's turn settles after the press. ChatPanel's onFinish sees
    // the finished session is no longer the live one and leaves the switch be.
    const restored = shouldRestoreChatWorkspace({
      chatWorkspaceId: "ws-a",
      activeWorkspaceId: getActiveWorkspaceId(),
      finishedSessionId: "chat-a",
      liveSessionId: "chat-b",
    })
    if (restored) setActiveWorkspaceId("ws-a")

    expect(restored).toBe(false)
    expect(getActiveWorkspaceId()).toBe("ws-b")
  })

  test("a finishing turn still restores its own workspace when nothing moved", () => {
    setActiveWorkspaceId("ws-b")

    expect(
      shouldRestoreChatWorkspace({
        chatWorkspaceId: "ws-a",
        activeWorkspaceId: getActiveWorkspaceId(),
        finishedSessionId: "chat-a",
        liveSessionId: "chat-a",
      }),
    ).toBe(true)
  })

  test("the status label rides along with the title", () => {
    const { container } = render(
      <ChatMentionChip
        id="chat-b"
        meta={{ id: "chat-b", title: "Deploy notes", workspaceId: "ws-b" }}
        status={{ queued: 1, working: false, repliedAt: null }}
      />,
    )

    expect(container.textContent).toBe("@Deploy notes · queued")
  })

  test("a delivered handoff keeps its state when the target's turn never answers", () => {
    const { container } = render(
      <ChatMentionChip
        id="chat-b"
        meta={{ id: "chat-b", title: "Deploy notes", workspaceId: "ws-b" }}
        status={{
          queued: 0,
          working: false,
          deliveredAt: "2026-10-19T12:02:00.000Z",
          repliedAt: null,
        }}
      />,
    )

    // No queue row and no reply left: without the durable state the chip would
    // be bare, which reads exactly like "the tag did nothing".
    expect(container.textContent).toBe("@Deploy notes · delivered")
  })

  test("a reply still outranks the delivered state", () => {
    const { container } = render(
      <ChatMentionChip
        id="chat-b"
        meta={{ id: "chat-b", title: "Deploy notes", workspaceId: "ws-b" }}
        status={{
          queued: 0,
          working: false,
          deliveredAt: "2026-10-19T12:02:00.000Z",
          repliedAt: "2026-10-19T12:05:00.000Z",
        }}
      />,
    )

    expect(container.textContent).toMatch(/^@Deploy notes · replied/)
  })

  test("a message body renders one chip per distinct tag", () => {
    // Ids no other case in this file resolves, so the chips fall back to their
    // id-derived labels and the assertion does not depend on cache order.
    const { container } = render(<ChatMentionText text="see <@c:chat-x> and <@c:chat-y>" />)
    const chips = Array.from(container.querySelectorAll("span")).filter((node) =>
      node.textContent?.startsWith("@"),
    )
    expect(chips.map((node) => node.textContent)).toEqual([
      "@chat chat-x",
      "@chat chat-y",
    ])
  })
})
