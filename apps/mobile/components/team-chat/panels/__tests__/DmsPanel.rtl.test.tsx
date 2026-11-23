// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

let chat: any

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement("button", { ...props, "aria-label": accessibilityLabel, onClick: onPress, role: accessibilityRole }, children),
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" "), Avatar: () => createElement("span") }))
mock.module("lucide-react-native", () => ({ Plus: () => createElement("span"), ChevronRight: () => createElement("span") }))
mock.module(resolve(import.meta.dir, "../../PresenceDot"), () => ({ PresenceDot: () => createElement("span") }))
// SHO-537: DmsPanel renders agent rows through the shared ChatRowView, so the
// stub has to exist here even though this file only asserts person rows.
const iconSize = (comfortable: boolean) => (comfortable ? 22 : 12)
mock.module(resolve(import.meta.dir, "../../ConversationRows"), () => ({
  ChatRowView: ({ title, subtitle, testID, comfortable }: any) =>
    createElement(
      "div",
      { "data-testid": testID ?? "chat-row", "data-comfortable": String(comfortable) },
      createElement("span", { "data-testid": "chat-row-title" }, title),
      subtitle ? createElement("span", { "data-testid": "chat-row-subtitle" }, subtitle) : null,
    ),
  rowIconSize: iconSize,
  ConversationRow: ({ conversation }: any) => createElement("div", { "data-testid": `row-${conversation.id}` }),
  PanelSection: ({ label, children }: any) => createElement("section", { "data-section": label }, createElement("h3", null, label), children),
  PanelLink: ({ label, onPress }: any) => createElement("button", { onClick: onPress }, label),
  CountPill: () => createElement("span"),
  attentionCount: () => 0,
  rowTitle: (c: any) => c.name ?? c.id,
}))
mock.module(resolve(import.meta.dir, "../../TeamChatSidebarProvider"), () => ({ useTeamChatNav: () => chat }))
// SHO-473: the panel reads agent chat rows from here; stub the hook so the test
// never loads expo-router's useFocusEffect (this file only asserts person DMs).
mock.module(resolve(import.meta.dir, "../../../../hooks/useRecentAgentChats"), () => ({
  useRecentAgentChats: () => ({ chats: [], loading: false }),
}))
mock.module("expo-router", () => ({
  useRouter: () => ({ push: () => {} }),
  useFocusEffect: () => {},
}))

const { DmsPanel } = await import("../DmsPanel")

const person = (id: string) => ({ type: "user", id, name: id, image: null })

function convo(over: any = {}) {
  return {
    id: "x",
    workspaceId: "w1",
    kind: "dm",
    name: null,
    slug: null,
    topic: null,
    lastSeq: 1,
    lastMessageAt: "2026-10-01T10:00:00Z",
    archivedAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    joined: true,
    starred: false,
    muted: false,
    notifyLevel: "all",
    lastReadSeq: 0,
    unreadCount: 0,
    mentionCount: 0,
    participants: [person("peer")],
    ...over,
  }
}

beforeEach(() => {
  cleanup()
  chat = { enabled: true, workspaceId: "w1", list: [], activeId: null, openConversation: () => {}, startCreate: () => {} }
})

describe("DmsPanel", () => {
  test("lifts a starred conversation into a Starred group instead of leaving it in the list", () => {
    chat.list = [
      convo({ id: "ana", starred: true, lastMessageAt: "2026-10-01T12:00:00Z" }),
      convo({ id: "bob", lastMessageAt: "2026-10-01T11:00:00Z" }),
    ]
    render(createElement(DmsPanel, {}))

    expect(screen.getByText("Starred")).toBeTruthy()
    expect(screen.getByTestId("row-ana")).toBeTruthy()
    expect(screen.getByTestId("row-bob")).toBeTruthy()
  })

  test("renders a starred row once, not again in the list below", () => {
    chat.list = [convo({ id: "ana", starred: true }), convo({ id: "bob" })]
    render(createElement(DmsPanel, {}))

    expect(screen.getAllByTestId("row-ana")).toHaveLength(1)
  })

  test("shows no Starred group when nothing is starred", () => {
    chat.list = [convo({ id: "bob" })]
    render(createElement(DmsPanel, {}))

    expect(screen.queryByText("Starred")).toBeNull()
    expect(screen.getByTestId("row-bob")).toBeTruthy()
  })

  test("the active chip narrows the Starred group too", () => {
    chat.list = [
      convo({ id: "ana", starred: true, unreadCount: 2, participants: [person("ana")] }),
      convo({ id: "bo", starred: true, unreadCount: 0, participants: [person("bo")] }),
    ]
    render(createElement(DmsPanel, {}))

    expect(screen.getByTestId("row-ana")).toBeTruthy()
    expect(screen.getByTestId("row-bo")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Unreads" }))

    expect(screen.getByTestId("row-ana")).toBeTruthy()
    expect(screen.queryByTestId("row-bo")).toBeNull()
  })

  test("keeps the empty message when a starred row is filtered out of every group", () => {
    chat.list = [convo({ id: "ana", starred: true, unreadCount: 0 })]
    render(createElement(DmsPanel, {}))

    expect(screen.getByText("Starred")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Unreads" }))

    expect(screen.queryByTestId("row-ana")).toBeNull()
    expect(screen.queryByText("Starred")).toBeNull()
    expect(screen.getByText("You're all caught up.")).toBeTruthy()
  })

  test("your own conversation is a row in the list, with no separate shortcut", () => {
    chat.list = [
      convo({ id: "mine", lastMessageAt: null, participants: [{ type: "user", id: "me", name: "Me Myself", image: null, self: true }] }),
      convo({ id: "ana" }),
    ]
    render(createElement(DmsPanel, {}))

    // The row is how you reach it. A "Note to self" link opened this same
    // conversation, so it only duplicated the row it sat under.
    expect(screen.getByTestId("row-mine")).toBeTruthy()
    expect(screen.getByTestId("row-ana")).toBeTruthy()
    expect(screen.queryByText("Note to self")).toBeNull()
  })

  // SHO-537: people are the reason you open this panel, so they lead the list;
  // agents follow under their own heading.
  test("under All, every people row and the New message link come before the Agents heading", () => {
    chat.list = [
      convo({ id: "ana", starred: true, participants: [person("ana")] }),
      convo({ id: "bob", participants: [person("bob")] }),
    ]
    chat.mentionables = { agents: [{ key: "ws", name: "Workspace agent", projectId: null, description: null, image: null }] }
    render(createElement(DmsPanel, {}))

    const html = document.body.innerHTML
    const agentsHeading = html.indexOf('data-section="Agents"')
    expect(agentsHeading).toBeGreaterThan(-1)
    expect(html.indexOf("row-ana")).toBeLessThan(agentsHeading)
    expect(html.indexOf("row-bob")).toBeLessThan(agentsHeading)
    expect(html.indexOf("New message")).toBeLessThan(agentsHeading)
    expect(html.indexOf("agent-row")).toBeGreaterThan(agentsHeading)
  })

  // SHOGO-IOS-14: the panel returned null above its last two useMemos, so a
  // workspace that switched team chat on mid-session rendered more hooks than
  // the previous render and React threw. Every hook must run before the return.
  test("rerendering from disabled to enabled does not change the hook count", () => {
    chat = { enabled: false, workspaceId: null, list: [convo({ id: "ana" })], activeId: null, openConversation: () => {}, startCreate: () => {} }
    const { rerender } = render(createElement(DmsPanel, {}))
    expect(screen.queryByTestId("row-ana")).toBeNull()

    chat = { ...chat, enabled: true, workspaceId: "w1" }
    rerender(createElement(DmsPanel, {}))

    expect(screen.getByTestId("row-ana")).toBeTruthy()
  })
})
