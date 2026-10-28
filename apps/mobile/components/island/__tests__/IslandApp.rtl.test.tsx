// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, forwardRef, useEffect, useState } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

const dir = import.meta.dir
const island = (name: string) => resolve(dir, "..", name)

let snapshotState: any
let layoutState: any
let pushSnapshot: (next: any) => void
let pushLayout: (next: any) => void
let createCalls = 0
let createdSessionId = "created-session"

const bridge = {
  sendAction: mock(async () => ({ ok: true })),
  readFiles: mock(async () => ({ ok: true, attachments: [] })),
  setContentHeight: () => {},
  onOpenCompose: () => () => {},
}

const emptySnapshot = { sessions: [], recentProjects: [], updatedAt: 1 }
const collapsedLayout = { mode: "collapsed", notched: false, topInset: 0, sounds: false, soundVolume: 0 }

const pendingPermissionSnapshot = {
  sessions: [
    {
      sessionId: "s1",
      projectId: "p1",
      projectName: "Website",
      title: "Fix the header",
      status: "needs_approval",
      lastActivityAt: 2,
      pending: {
        kind: "permission",
        request: {
          id: "req-1",
          toolName: "Bash",
          category: "shell",
          params: {},
          reason: "Run the tests",
          timeout: 60_000,
          startedAt: 1,
        },
      },
    },
  ],
  recentProjects: [{ projectId: "p1", name: "Website" }],
  updatedAt: 2,
}

const mixedSnapshot = {
  sessions: [
    pendingPermissionSnapshot.sessions[0],
    {
      sessionId: "s2",
      projectId: "p2",
      projectName: "Atlas",
      title: "Ship the banner",
      status: "running",
      lastActivityAt: 1,
    },
  ],
  recentProjects: [
    { projectId: "p1", name: "Website" },
    { projectId: "p2", name: "Atlas" },
  ],
  updatedAt: 3,
}

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: forwardRef(function Pressable(props: any, ref: any) {
      const { accessibilityLabel, children, onPress, testID, ...rest } = props
      return createElement(
        "button",
        { ...rest, ref, onClick: onPress, "aria-label": accessibilityLabel, "data-testid": testID },
        children,
      )
    }),
  }),
)
mock.module("@legendapp/motion", () => ({
  Motion: {
    View: forwardRef(function MotionView(props: any, ref: any) {
      return createElement("div", { ...props, ref }, props.children)
    }),
  },
}))
mock.module("mobx-react-lite", () => ({ observer: (component: any) => component }))
mock.module("lucide-react-native", () => {
  const Icon = () => createElement("span")
  return {
    ChevronDown: Icon,
    ChevronLeft: Icon,
    ChevronsUpDown: Icon,
    ExternalLink: Icon,
    Minus: Icon,
  }
})
mock.module("@shogo/shared-ui/primitives", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }))
mock.module(resolve(dir, "../../../contexts/domain"), () => ({
  useDomainActions: () => ({ createChatSession: mock(async () => ({ id: "project-session" })) }),
  useDomainHttp: () => ({}),
}))
mock.module(resolve(dir, "../../../hooks/useOpenQuestions"), () => ({ useOpenQuestionCount: () => 0 }))
mock.module(resolve(dir, "../../../lib/agent-mode-preference"), () => ({
  loadModelPreference: async () => "auto",
}))
mock.module(resolve(dir, "../../chat/ChatInput"), () => ({ DEFAULT_MODEL: "auto" }))
mock.module(island("useIslandBridge"), () => ({
  useIslandBridge: () => {
    const [snapshot, setSnapshot] = useState(snapshotState)
    const [layout, setLayout] = useState(layoutState)
    pushSnapshot = setSnapshot
    pushLayout = setLayout
    return {
      bridge,
      snapshot,
      layout,
      meeting: { prompt: null, recording: null },
      requestMode: (mode: string) => setLayout((current: any) => ({ ...current, mode })),
    }
  },
}))
mock.module(island("useIslandPointer"), () => ({ useIslandPointer: () => {} }))
mock.module(island("island-accent"), () => ({ useIslandAccent: () => "#ffffff" }))
mock.module(island("island-sounds"), () => ({
  playIslandSound: () => {},
  islandSoundForTransition: () => null,
  meetingSoundForTransition: () => null,
}))
mock.module(island("buddy/buddy-state"), () => ({ buddyStateForSnapshot: () => "idle" }))
mock.module(island("buddy/IslandBuddy"), () => ({ IslandBuddy: () => null }))
mock.module(island("buddy/look"), () => ({ normalizeBuddyLook: (look: unknown) => look }))
mock.module(island("IslandIdle"), () => ({ IslandIdle: () => null }))
mock.module(island("IslandCollapsed"), () => ({
  IslandCollapsed: ({ onExpand }: any) => createElement("button", { onClick: onExpand }, "expand"),
}))
mock.module(island("IslandComposer"), () => ({
  fileRefsFromFileList: () => [],
  IslandComposer: forwardRef(function IslandComposer(props: any, ref: any) {
    useEffect(() => {
      if (ref) ref.current = { focus: () => {} }
    }, [ref])
    return createElement(
      "div",
      { "data-testid": "composer", "data-placeholder": props.placeholder },
      createElement("button", { onClick: () => void props.onSend("hello", []) }, "send"),
    )
  }),
}))
mock.module(island("IslandChatHost"), () => ({
  IslandChatHost: ({ children, context }: any) =>
    createElement(
      "div",
      { "data-testid": "chat-host", "data-session": context.sessionId },
      children({
        sessionId: context.sessionId,
        projectId: context.projectId,
        owned: false,
        messages: [],
        isStreaming: false,
        isLoading: false,
        permission: null,
        question: null,
        plan: null,
        error: null,
        send: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        respondPermission: async () => ({ ok: true }),
        answerQuestion: async () => ({ ok: true }),
        buildPlan: async () => ({ ok: true }),
        sendPlanFeedback: async () => ({ ok: true }),
      }),
    ),
}))
mock.module(island("IslandConversation"), () => ({
  IslandConversation: ({ footer }: any) => createElement("div", { "data-testid": "conversation" }, footer),
}))
mock.module(island("IslandDropSheet"), () => ({ IslandDropSheet: () => null }))
mock.module(island("IslandMeeting"), () => ({ IslandMeetingBanner: () => null }))
mock.module(island("useIslandMeetingNotes"), () => ({ useIslandMeetingNotes: () => null }))
mock.module(island("IslandPlanReview"), () => ({ IslandPlanReview: () => null }))
mock.module(island("IslandUsageChip"), () => ({
  IslandUsageChip: () => null,
  IslandUsagePanel: () => null,
  useIslandUsage: () => ({ hasAdvancedModelAccess: false }),
}))
mock.module(island("PendingCard"), () => ({
  PermissionCard: ({ permission }: any) =>
    createElement("div", { "data-testid": "permission" }, permission.requestId ?? permission.id),
  QuestionCard: () => null,
}))
mock.module(island("ProjectSwitcher"), () => ({ ProjectSwitcher: () => null, useWorkspaceProjects: () => [] }))
mock.module(island("SessionList"), () => ({
  SessionList: () => null,
  SessionRow: ({ row, onPress }: any) =>
    createElement("button", { onClick: onPress, "data-testid": `row-${row.sessionId}` }, row.title),
}))
mock.module(island("island-drop"), () => ({
  planAddToProject: () => ({ writes: [], attach: [] }),
  saveAttachmentsPrompt: () => "",
}))
mock.module(island("useWorkspaceAgentSession"), () => ({
  useWorkspaceAgentName: () => "Shogo",
  useWorkspaceAgentChats: () => ({ chats: [], loading: false, error: null }),
  useWorkspaceAgentSessionCreator: () => async () => {
    createCalls += 1
    return { id: createdSessionId }
  },
}))

const { IslandApp } = await import("../IslandApp")

function expand() {
  fireEvent.click(screen.getByText("expand"))
}

beforeEach(() => {
  cleanup()
  createCalls = 0
  snapshotState = emptySnapshot
  layoutState = { ...collapsedLayout }
})

afterEach(() => {
  cleanup()
})

describe("IslandApp — workspace agent notch", () => {
  test("opening the notch shows a blank agent chat and creates no session", () => {
    render(createElement(IslandApp, { workspaceId: "ws-1", userId: "user-1" }))
    act(() => expand())

    const composer = screen.getByTestId("composer")
    expect(composer.getAttribute("data-placeholder")).toBe("Message Shogo…")
    expect(screen.queryByTestId("chat-host")).toBeNull()
    expect(createCalls).toBe(0)
  })

  test("the first send creates one workspace session and opens it", async () => {
    render(createElement(IslandApp, { workspaceId: "ws-1", userId: "user-1" }))
    act(() => expand())
    await act(async () => {
      fireEvent.click(screen.getByText("send"))
    })

    expect(createCalls).toBe(1)
    expect(screen.getByTestId("chat-host").getAttribute("data-session")).toBe(createdSessionId)
  })

  test("reopening the notch starts blank again", () => {
    render(createElement(IslandApp, { workspaceId: "ws-1", userId: "user-1" }))
    act(() => expand())
    act(() => {
      pushLayout({ ...collapsedLayout })
    })
    act(() => {
      pushLayout({ ...collapsedLayout, mode: "expanded" })
    })

    expect(screen.getByTestId("composer").getAttribute("data-placeholder")).toBe("Message Shogo…")
    expect(screen.queryByTestId("chat-host")).toBeNull()
  })

  test("a permission request that arrives while the notch is open takes over the card", () => {
    render(createElement(IslandApp, { workspaceId: "ws-1", userId: "user-1" }))
    act(() => expand())
    act(() => {
      pushSnapshot(pendingPermissionSnapshot)
    })

    expect(screen.getByTestId("chat-host").getAttribute("data-session")).toBe("s1")
  })

  test("a permission request that arrives while the notch is closed takes over the card", () => {
    render(createElement(IslandApp, { workspaceId: "ws-1", userId: "user-1" }))

    // The request lands while the notch is collapsed, then the island opens
    // for it — snapshot first, layout second, the way the main process sends
    // them (see isnland-window.ts reconcileMode).
    act(() => {
      pushSnapshot(pendingPermissionSnapshot)
    })
    act(() => {
      pushLayout({ ...collapsedLayout, mode: "expanded" })
    })

    expect(screen.getByTestId("chat-host").getAttribute("data-session")).toBe("s1")
  })

  test("the inbox puts a waiting project chat under Needs you, once", () => {
    snapshotState = mixedSnapshot
    render(createElement(IslandApp, { workspaceId: "ws-1", userId: "user-1" }))
    act(() => expand())

    // The open lands on the waiting chat; back out to its project, then to the inbox.
    act(() => {
      fireEvent.click(screen.getByLabelText("Back"))
    })
    act(() => {
      fireEvent.click(screen.getByLabelText("Back"))
    })

    expect(screen.getByText("Needs you")).toBeTruthy()
    expect(screen.getAllByText("Fix the header")).toHaveLength(1)
    expect(screen.getByText("Ship the banner")).toBeTruthy()
  })
})
