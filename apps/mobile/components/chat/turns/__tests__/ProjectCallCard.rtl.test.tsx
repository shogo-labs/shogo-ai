// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RTL coverage for ProjectCallCard — the `project_call` tool card.
 *
 * Locks:
 *   - status per tool state (calling, replied, queued, failed)
 *   - request + reply/error preview, deliverable links
 *   - "Open chat" / "Open project" go to the side pane when the host has one,
 *     and navigate to the project otherwise
 *   - a runtime-internal session key is never offered as an openable chat
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const Host = React.forwardRef<HTMLElement, Record<string, unknown>>(function Host(
  { accessibilityLabel, children, disabled, onPress, testID, ...props },
  ref,
) {
  return React.createElement(
    "button",
    {
      ...props,
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      disabled,
      onClick: disabled ? undefined : onPress,
      ref,
    },
    children as React.ReactNode,
  )
})
const TextHost = React.forwardRef<HTMLElement, Record<string, unknown>>(function TextHost(
  { children, testID, numberOfLines: _n, selectable: _s, ...props },
  ref,
) {
  return React.createElement("span", { ...props, "data-testid": testID, ref }, children as React.ReactNode)
})
const ViewHost = React.forwardRef<HTMLElement, Record<string, unknown>>(function ViewHost(
  { children, testID, ...props },
  ref,
) {
  return React.createElement("div", { ...props, "data-testid": testID, ref }, children as React.ReactNode)
})

const openURL = mock(async (_url: string) => {})
mock.module(
  "react-native",
  () => createReactNativeMock({ Pressable: Host, Text: TextHost, View: ViewHost, Linking: { openURL, canOpenURL: async () => false, addEventListener: () => ({ remove: () => {} }) } }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("lucide-react-native", () => {
  const Icon = () => React.createElement("i")
  return { CheckCircle2: Icon, Clock: Icon, ExternalLink: Icon, MessageSquare: Icon, PanelRight: Icon, XCircle: Icon }
})

const push = mock((_to: unknown) => {})
mock.module("expo-router", () => ({ useRouter: () => ({ push }) }))
mock.module("../../../team-chat/AgentAvatar", () => ({
  AgentAvatar: ({ name }: { name: string }) => React.createElement("i", { "data-testid": "avatar" }, name),
}))

let chatContext: any = null
mock.module("../../ChatContext", () => ({ useChatContextSafe: () => chatContext }))

const { ProjectCallCard, parseProjectCall } = await import("../ProjectCallCard")

const CHAT_ID = "9b1c2d3e-0000-5000-8000-000000000001"

function tool(over: Record<string, unknown> = {}): any {
  return {
    id: "t1",
    toolName: "project_call",
    category: "other",
    state: "success",
    timestamp: 0,
    args: { project: "Worker", message: "Build the landing page", runId: "run_abcdef123456" },
    result: {
      ok: true,
      project: { id: "proj-2", name: "Worker" },
      runId: "run_abcdef123456",
      status: "completed",
      wait: true,
      sessionId: CHAT_ID,
      chatSessionId: CHAT_ID,
      reply: "Done. Preview: https://demo.shogo.one",
      deliverables: [{ type: "url", label: "Worker", href: "https://demo.shogo.one", projectId: "proj-2" }],
    },
    ...over,
  }
}

beforeEach(() => {
  chatContext = null
  push.mockClear()
  openURL.mockClear()
})
afterEach(cleanup)

describe("ProjectCallCard", () => {
  test("shows the project, request, reply and a link for a finished call", () => {
    render(<ProjectCallCard tool={tool()} />)
    expect(screen.getByText("Worker", { selector: "span" })).toBeTruthy()
    expect(screen.getByTestId("project-call-status").textContent).toBe("Replied")
    expect(screen.getByText("Build the landing page")).toBeTruthy()
    expect(screen.getByText("Done. Preview: https://demo.shogo.one")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Open https://demo.shogo.one"))
    expect(openURL).toHaveBeenCalledWith("https://demo.shogo.one")
  })

  test("shows calling while the call is in flight, and cannot open before the project is known", () => {
    render(<ProjectCallCard tool={tool({ state: "streaming", result: undefined })} />)
    expect(screen.getByTestId("project-call-status").textContent).toMatch(/^Calling/)
    expect((screen.getByLabelText("Open project Worker") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText("Open chat with Worker") as HTMLButtonElement).disabled).toBe(true)
  })

  test("shows queued for a wait=false call", () => {
    render(
      <ProjectCallCard
        tool={tool({
          args: { project: "Worker", message: "go", wait: false },
          result: { ok: true, project: { id: "proj-2", name: "Worker" }, status: "accepted", wait: false, chatSessionId: CHAT_ID },
        })}
      />,
    )
    expect(screen.getByTestId("project-call-status").textContent).toBe("Queued")
  })

  test("shows the error and hint for a failed call", () => {
    render(
      <ProjectCallCard
        tool={tool({
          state: "success",
          result: {
            error: "timed out",
            code: "agent_call_timeout",
            project: { id: "proj-2", name: "Worker" },
            hint: "The callee is still working.",
          },
        })}
      />,
    )
    expect(screen.getByTestId("project-call-status").textContent).toBe("Failed")
    expect(screen.getByText("timed out")).toBeTruthy()
    expect(screen.getByText("The callee is still working.")).toBeTruthy()
  })

  test("opens the chat and the project in the side pane when the host provides one", () => {
    const openProjectPane = mock((_req: unknown) => {})
    chatContext = { openProjectPane, workspaceId: "ws-1" }
    render(<ProjectCallCard tool={tool()} />)

    fireEvent.click(screen.getByLabelText("Open chat with Worker"))
    expect(openProjectPane).toHaveBeenLastCalledWith({
      projectId: "proj-2",
      name: "Worker",
      chatSessionId: CHAT_ID,
      tab: "chat",
    })

    fireEvent.click(screen.getByLabelText("Open project Worker"))
    expect(openProjectPane).toHaveBeenLastCalledWith({
      projectId: "proj-2",
      name: "Worker",
      chatSessionId: undefined,
      tab: "canvas",
    })
    expect(push).not.toHaveBeenCalled()
  })

  test("navigates to the project chat when there is no side pane", () => {
    render(<ProjectCallCard tool={tool()} />)
    fireEvent.click(screen.getByLabelText("Open chat with Worker"))
    expect(push).toHaveBeenLastCalledWith({
      pathname: "/(app)/projects/[id]",
      params: { id: "proj-2", chatSessionId: CHAT_ID },
    })
    fireEvent.click(screen.getByLabelText("Open project Worker"))
    expect(push).toHaveBeenLastCalledWith({ pathname: "/(app)/projects/[id]", params: { id: "proj-2" } })
  })
})

describe("parseProjectCall", () => {
  test("does not offer a runtime session key as a chat", () => {
    const view = parseProjectCall(tool({ result: { project: { id: "p", name: "W" }, chatSessionId: "run:abc", sessionId: "run:abc" } }))
    expect(view.chatSessionId).toBeNull()
  })

  test("reads results wrapped as JSON text or tool content", () => {
    const payload = { project: { id: "p", name: "W" }, reply: "hi", chatSessionId: CHAT_ID }
    expect(parseProjectCall(tool({ result: JSON.stringify(payload) })).reply).toBe("hi")
    expect(parseProjectCall(tool({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })).chatSessionId).toBe(CHAT_ID)
    expect(parseProjectCall(tool({ result: { details: payload } })).projectId).toBe("p")
  })

  test("falls back to the requested project name before a result exists", () => {
    const view = parseProjectCall(tool({ state: "streaming", result: undefined }))
    expect(view.projectName).toBe("Worker")
    expect(view.projectId).toBeNull()
  })
})
