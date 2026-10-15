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
mock.module("lucide-react-native", () => ({ NotebookText: () => createElement("span"), Plus: () => createElement("span") }))
mock.module(resolve(import.meta.dir, "../../../activity/ActivityFeed"), () => ({ AgentMark: () => createElement("span") }))
mock.module(resolve(import.meta.dir, "../../PresenceDot"), () => ({ PresenceDot: () => createElement("span") }))
mock.module(resolve(import.meta.dir, "../../ConversationRows"), () => ({
  ConversationRow: ({ conversation }: any) => createElement("div", { "data-testid": `row-${conversation.id}` }),
  PanelSection: ({ label, children }: any) => createElement("section", { "data-section": label }, createElement("h3", null, label), children),
  PanelLink: ({ label, onPress }: any) => createElement("button", { onClick: onPress }, label),
  CountPill: () => createElement("span"),
  attentionCount: () => 0,
  rowTitle: (c: any) => c.name ?? c.id,
}))
mock.module(resolve(import.meta.dir, "../../TeamChatSidebarProvider"), () => ({ useTeamChatNav: () => chat }))

const { DmsPanel } = await import("../DmsPanel")

const person = (id: string) => ({ type: "user", id, name: id, image: null })
const agent = (projectId: string) => ({ type: "agent", projectId, name: projectId })

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
      convo({ id: "ana", starred: true, participants: [person("ana")] }),
      convo({ id: "bot", starred: true, participants: [agent("p1")] }),
    ]
    render(createElement(DmsPanel, {}))

    expect(screen.getByTestId("row-ana")).toBeTruthy()
    expect(screen.getByTestId("row-bot")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Agents" }))

    expect(screen.getByTestId("row-bot")).toBeTruthy()
    expect(screen.queryByTestId("row-ana")).toBeNull()
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

  test("offers a note-to-self link that opens the conversation with yourself", () => {
    const opened: any[] = []
    chat.openConversation = (c: any) => opened.push(c)
    chat.me = "me"
    // The server marks your own participant row; a note has you as its only member.
    chat.list = [
      convo({ id: "mine", lastMessageAt: null, participants: [{ type: "user", id: "me", name: "Me Myself", image: null, self: true }] }),
      convo({ id: "ana" }),
    ]
    render(createElement(DmsPanel, {}))

    fireEvent.click(screen.getByText("Note to self"))

    expect(opened.map((c) => c.id)).toEqual(["mine"])
  })

  test("your own note also appears in the list, like any other conversation", () => {
    chat.list = [
      convo({ id: "mine", lastMessageAt: null, participants: [{ type: "user", id: "me", name: "Me Myself", image: null, self: true }] }),
      convo({ id: "ana" }),
    ]
    render(createElement(DmsPanel, {}))

    // Reachable from the link and as a row, matching how Slack lists "You".
    expect(screen.getByText("Note to self")).toBeTruthy()
    expect(screen.getByTestId("row-mine")).toBeTruthy()
    expect(screen.getByTestId("row-ana")).toBeTruthy()
  })
})
