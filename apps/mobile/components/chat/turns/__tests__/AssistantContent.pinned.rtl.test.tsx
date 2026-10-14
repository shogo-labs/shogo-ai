// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Once a turn finishes, its work log folds under "Worked for X". Cards the user still has to act
 * on (a connection awaiting auth, an unanswered question, a plan) stay visible outside the fold.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web", select: (s: any) => s.web ?? s.default },
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
}))

const stub = (label: string) => (props: any) =>
  createElement("div", { "data-rn-shim": label }, label, props.children)

mock.module("../WorkedForGroup", () => ({
  WorkedForGroup: ({ isExpanded, children }: any) =>
    createElement("div", null, "Worked for", isExpanded ? children : null),
}))
mock.module("../ConnectToolWidget", () => ({
  ConnectToolWidget: ({ toolkitName }: any) =>
    createElement("div", null, `Connect ${toolkitName}`),
  parseToolInstallResult: (r: unknown) => (typeof r === "object" ? r : null),
}))
mock.module("../WorkGroup", () => ({ WorkGroup: stub("work-group") }))
mock.module("../CollapsibleToolGroup", () => ({ CollapsibleToolGroup: stub("collapsible") }))
mock.module("../InlineToolWidget", () => ({ InlineToolWidget: stub("inline-tool") }))
mock.module("../SubagentCard", () => ({ SubagentCard: stub("subagent") }))
mock.module("../ProjectCallCard", () => ({ ProjectCallCard: stub("project-call") }))
mock.module("../TeamCard", () => ({ TeamCard: stub("team") }))
mock.module("../ExecWidget", () => ({ ExecWidget: stub("exec") }))
mock.module("../AskUserQuestionWidget", () => ({
  AskUserQuestionBar: stub("ask-bar"),
  AskUserAskedRow: stub("ask-row"),
}))
mock.module("../TodoRow", () => ({ TodoRow: stub("todo") }))
mock.module("../ToolCallGroup", () => ({ ToolCallGroup: stub("tool-group") }))
mock.module("../PlanningStatusLine", () => ({ PlanningStatusLine: stub("planning") }))
mock.module("../GenerateImageWidget", () => ({ GenerateImageWidget: stub("gen-image") }))
mock.module("../FileDeliveryWidget", () => ({ FileDeliveryWidget: stub("file-delivery") }))
mock.module("../GeneratedImageGallery", () => ({ GeneratedImageGallery: stub("gallery") }))
mock.module("../BrowserWidget", () => ({ BrowserWidget: stub("browser") }))
mock.module("../ThinkingWidget", () => ({ ThinkingWidget: stub("thinking") }))
mock.module("../WriteFileWidget", () => ({ WriteFileWidget: stub("write") }))
mock.module("../EditFileWidget", () => ({ EditFileWidget: stub("edit") }))
mock.module("../PlanReferenceCard", () => ({ PlanReferenceCard: stub("plan-card") }))
mock.module("../../ChatMarkdown", () => ({
  ChatMarkdown: ({ children }: any) => createElement("p", null, children),
}))
mock.module("../../ChatContext", () => ({ useChatContextSafe: () => null }))
mock.module("../../FileViewerModal", () => ({ FileViewerModal: () => null }))
mock.module("../../ImagePreviewModal", () => ({
  ChatImageContextMenu: () => null,
  ImagePreviewModal: () => null,
}))
mock.module("../../chatImageActions", () => ({
  downloadImage: () => {},
  isShogoDesktop: () => false,
}))
mock.module("../../../../lib/native-phone-layout", () => ({
  useIsNativePhoneLayout: () => false,
}))
mock.module("../../../../lib/agent-image-source", () => ({
  useAgentImageSource: (url: string) => ({ uri: url }),
}))
mock.module("../../../../lib/todo-state-store", () => ({
  useTodoStateStore: () => ({ setTodos: () => {}, updateFromTool: () => {} }),
  parseTodos: () => [],
}))
mock.module("../../../../lib/file-change-store", () => ({
  useFileChangeStore: () => ({ recordChange: () => {} }),
  classifyFileToolName: () => null,
  extractFilePath: () => null,
}))

const { AssistantContent } = await import("../AssistantContent")

function finishedMessage(parts: any[]) {
  return {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "data-turn-timing", data: { startedAt: 1_000, completedAt: 9_000 } },
      ...parts,
    ],
  } as any
}

const connectNeedingAuth = {
  type: "dynamic-tool",
  toolCallId: "c1",
  toolName: "connect",
  state: "output-available",
  input: { integration: "github" },
  output: { authStatus: "needs_auth", authUrl: "https://auth.example", integration: "GitHub" },
}

const readFile = {
  type: "dynamic-tool",
  toolCallId: "r1",
  toolName: "read_file",
  state: "output-available",
  input: { path: "README.md" },
  output: "contents",
}

afterEach(cleanup)

describe("AssistantContent pinned work", () => {
  test("a connection awaiting auth stays visible after the turn folds", () => {
    render(
      createElement(AssistantContent, {
        message: finishedMessage([connectNeedingAuth, readFile, { type: "text", text: "Done" }]),
        isStreaming: false,
      }),
    )
    expect(screen.getByText("Worked for")).toBeTruthy()
    expect(screen.getByText("Connect GitHub")).toBeTruthy()
    expect(screen.getByText("Done")).toBeTruthy()
    expect(screen.queryByText("work-group")).toBeNull()
  })

  test("ordinary work stays inside the fold", () => {
    render(
      createElement(AssistantContent, {
        message: finishedMessage([readFile, { type: "text", text: "All set" }]),
        isStreaming: false,
      }),
    )
    expect(screen.getByText("Worked for")).toBeTruthy()
    expect(screen.queryByText("work-group")).toBeNull()
    expect(screen.queryByText("Connect GitHub")).toBeNull()
  })
})
